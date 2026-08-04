/**
 * Bluetooth LE transport.
 *
 * This is the one that matters: no internet, no server, no shared WiFi. One
 * phone advertises, the others connect to it, and the match runs over GATT.
 *
 * ## Topology
 *
 * The host is the GATT **peripheral** and advertises a service UUID. Everyone
 * else is a **central** that scans for it and connects. That is the opposite of
 * the intuitive arrangement -- "the host should be the one doing the scanning"
 * -- but it is the only one that works cross-platform:
 *
 *   - A central can only talk to peripherals it has connected to. If clients
 *     were peripherals, they could not reach each other or be discovered as a
 *     group under one advertised match.
 *   - iOS can act as a peripheral with multiple subscribed centrals, and can
 *     notify them individually. Android's peripheral role can likewise target a
 *     specific device. So one peripheral serving N centrals is portable.
 *   - Android centrals cannot see iOS peripherals advertising in the background,
 *     which is why the host must be in the foreground with the screen on. That
 *     is fine for a game and fatal for anything else, so it is worth knowing.
 *
 * ## Characteristics
 *
 * Two, both on one service:
 *
 *   TX (host -> client): notify/indicate. The peripheral pushes here.
 *   RX (client -> host): write / write-without-response. Centrals push here.
 *
 * ## Reliability
 *
 * We do not implement acks. BLE already has both modes and they map exactly
 * onto what the protocol needs:
 *
 *   reliable   -> indication (host->client) or write-with-response (client->host)
 *   unreliable -> notification or write-without-response
 *
 * Rolling our own retransmit on top would duplicate the link layer and add
 * latency to the one thing that must not have it. Snapshots go unreliable
 * because a lost one is superseded 66ms later; shell spawns go reliable because
 * a client that misses one has an invisible shell flying at it.
 *
 * ## Platform binding
 *
 * `core` must not import react-native-ble-plx or any native module -- it has to
 * keep running in Node tests and in a browser. So the platform talks to this
 * class through BleAdapter, and the app supplies the implementation.
 */

import {
  TransportKind,
  type Peer,
  type PeerId,
  type Transport,
  type TransportEvents,
} from './transport.js';

/**
 * Service and characteristic UUIDs.
 *
 * Randomly generated for this game. iOS filters background scan results by
 * service UUID, so this has to be a fixed, known constant rather than something
 * derived per match.
 */
export const BLE_SERVICE_UUID = '6b1e4a30-9d2c-4f11-b8a7-2c5e19d4f0a1';
export const BLE_TX_CHARACTERISTIC = '6b1e4a31-9d2c-4f11-b8a7-2c5e19d4f0a1';
export const BLE_RX_CHARACTERISTIC = '6b1e4a32-9d2c-4f11-b8a7-2c5e19d4f0a1';

/**
 * Bytes of framing overhead per fragment. See BleFramer for the layout.
 */
export const FRAME_HEADER_BYTES = 2;

/**
 * Conservative payload ceiling.
 *
 * iOS negotiates an ATT MTU around 185 and will not go below 23. Android often
 * offers 517 but a cross-platform match is limited by whichever end is worse,
 * and a write that exceeds the negotiated MTU is silently truncated rather than
 * rejected -- which would corrupt a snapshot instead of dropping it. So we
 * assume the pessimistic value unless the adapter reports better.
 */
export const BLE_SAFE_MTU = 180;

/**
 * Fragmentation and reassembly.
 *
 * Most of our traffic fits in a single write -- an input frame is 8 bytes and an
 * 8-tank snapshot is 52 -- so this is not on the hot path. It exists because
 * lobby and match-start messages grow with player count, and because a silently
 * truncated packet is far worse than a fragmented one.
 *
 * Header, 2 bytes:
 *   byte 0: message id, rolling 0-255. Groups fragments of one message.
 *   byte 1: bit 7 = last fragment, bits 0-6 = fragment index (0-127).
 *
 * That caps a message at 128 fragments, ~22KB at our MTU, far more than
 * anything the protocol sends.
 *
 * ## One message at a time, per peer
 *
 * The message id is eight bits, so it comes round again every 256 sends -- at
 * 15 snapshots a second, every seventeen seconds. That is short enough to
 * matter: a message that lost a fragment leaves its surviving fragments
 * behind, and if they are still buffered when the id repeats, the fragments of
 * the new message land in the same slots and the two are handed up as one.
 * Measured, not theorised: an 18-byte-payload framer spliced 18 bytes of an
 * abandoned message onto 10 bytes of a fresh one and returned it as a complete
 * 28-byte snapshot. Half a frame of new tank positions and half a frame of
 * old, and nothing downstream can tell.
 *
 * So reassembly holds exactly one message per peer, and anything that is not a
 * continuation of it throws it away. Fragments of a message are written back
 * to back on one connection, so anything arriving in between -- a whole
 * single-frame message, or the start of a different one -- proves the held
 * message was abandoned. That makes id reuse unreachable rather than
 * unlikely, because the 255 messages in between each clear the slot.
 *
 * The cost is that a message whose *first* fragment is lost is dropped on the
 * spot instead of at its last fragment. It was already unrecoverable; this
 * only stops it holding a slot on the way to being discarded.
 */
export class BleFramer {
  private nextMessageId = 0;
  /** peerId -> the one message currently being reassembled from that peer. */
  private pending = new Map<PeerId, { id: number; parts: (Uint8Array | undefined)[] }>();

  /**
   * A function, not a number, when the caller has a link that renegotiates.
   *
   * A BLE MTU is agreed after the connection is up, so anything that reads it
   * once -- at construction, which is necessarily before any phone has
   * connected -- captures the conservative default and keeps it for the life
   * of the match. That is not a small loss: it cut every message into 18-byte
   * pieces on a link that had agreed to carry 183, ten times the writes and
   * ten times the header, on the one budget this whole protocol is shaped
   * around.
   */
  constructor(private payload: number | (() => number) = BLE_SAFE_MTU - FRAME_HEADER_BYTES) {}

  /** Checked here rather than in the constructor, which a function outruns. */
  private get payloadSize(): number {
    const n = typeof this.payload === 'function' ? this.payload() : this.payload;
    if (n < 8) throw new Error(`BLE payload size ${n} is unusably small`);
    return n;
  }

  /** Split a message into wire frames. */
  fragment(data: Uint8Array): Uint8Array[] {
    const id = this.nextMessageId;
    this.nextMessageId = (this.nextMessageId + 1) & 0xff;

    const count = Math.max(1, Math.ceil(data.length / this.payloadSize));
    if (count > 128) throw new Error(`message of ${data.length}B needs ${count} fragments, max 128`);

    const frames: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const slice = data.subarray(i * this.payloadSize, (i + 1) * this.payloadSize);
      const frame = new Uint8Array(FRAME_HEADER_BYTES + slice.length);
      frame[0] = id;
      frame[1] = (i & 0x7f) | (i === count - 1 ? 0x80 : 0);
      frame.set(slice, FRAME_HEADER_BYTES);
      frames.push(frame);
    }
    return frames;
  }

  /**
   * Feed a received frame. Returns the complete message once the last fragment
   * of a group has arrived, otherwise null.
   *
   * Single-fragment messages -- which is nearly all of them -- bypass the
   * reassembly buffers entirely.
   */
  reassemble(from: PeerId, frame: Uint8Array): Uint8Array | null {
    if (frame.length < FRAME_HEADER_BYTES) return null;

    const id = frame[0];
    const index = frame[1] & 0x7f;
    const last = (frame[1] & 0x80) !== 0;
    const payload = frame.subarray(FRAME_HEADER_BYTES);

    if (last && index === 0) {
      // A whole message in one frame, which is nearly all of them. It also
      // settles anything half-assembled from this peer: fragments go out back
      // to back, so a complete message arriving between them means the earlier
      // one is never finishing.
      this.pending.delete(from);
      return payload.slice();
    }

    if (index === 0) {
      this.pending.set(from, { id, parts: [payload.slice()] });
      return null;
    }

    const open = this.pending.get(from);
    if (!open || open.id !== id) {
      // A continuation with nothing to continue: this message's first fragment
      // was lost, so it cannot be rebuilt however many of the rest arrive. Drop
      // it, and drop whatever was held -- a fragment of a different message is
      // the same proof that the held one was abandoned.
      this.pending.delete(from);
      return null;
    }
    open.parts[index] = payload.slice();

    if (!last) return null;

    // Last fragment seen: we know the count, so check we have all of them.
    this.pending.delete(from);
    const total = index + 1;
    let size = 0;
    for (let i = 0; i < total; i++) {
      const p = open.parts[i];
      if (!p) return null; // a fragment was lost; drop the whole message
      size += p.length;
    }

    const out = new Uint8Array(size);
    let offset = 0;
    for (let i = 0; i < total; i++) {
      out.set(open.parts[i]!, offset);
      offset += open.parts[i]!.length;
    }
    return out;
  }

  forgetPeer(peerId: PeerId): void {
    this.pending.delete(peerId);
  }
}

/** What the platform layer must provide. Implemented in the app, not here. */
export interface BleAdapter {
  /** Negotiated payload size, excluding our frame header. */
  readonly payloadSize: number;

  /** Host: advertise the service so centrals can find us. */
  startAdvertising(matchName: string): Promise<void>;
  stopAdvertising(): Promise<void>;

  /** Client: scan for hosts advertising our service UUID. */
  startScanning(onFound: (peer: Peer) => void): Promise<void>;
  stopScanning(): Promise<void>;

  connect(peerId: PeerId): Promise<void>;
  disconnect(peerId: PeerId): Promise<void>;

  /**
   * Send one frame, already sized to fit. `ack` selects
   * indication/write-with-response over notification/write-without-response.
   */
  sendFrame(to: PeerId, frame: Uint8Array, ack: boolean): void;

  onFrame(cb: (from: PeerId, frame: Uint8Array) => void): void;
  onPeerConnected(cb: (peer: Peer) => void): void;
  onPeerDisconnected(cb: (peerId: PeerId, reason: string) => void): void;
}

export class BleTransport implements Transport {
  readonly kind = TransportKind.Ble;

  private framer: BleFramer;
  private events: Partial<TransportEvents> = {};
  private peers = new Map<PeerId, Peer>();

  constructor(private adapter: BleAdapter) {
    // Read on every fragment, not captured here: this constructor runs before
    // any phone has connected, so the value at this instant is always the
    // conservative default and never the one the link went on to agree.
    this.framer = new BleFramer(() => adapter.payloadSize);

    adapter.onFrame((from, frame) => {
      const message = this.framer.reassemble(from, frame);
      if (message) this.events.onPacket?.(from, message);
    });

    adapter.onPeerConnected((peer) => {
      this.peers.set(peer.id, peer);
      this.events.onPeerJoin?.(peer);
    });

    adapter.onPeerDisconnected((peerId, reason) => {
      this.peers.delete(peerId);
      this.framer.forgetPeer(peerId);
      this.events.onPeerLeave?.(peerId, reason);
    });
  }

  /**
   * Largest message callers may send.
   *
   * Reported as the fragmentable maximum rather than the per-write MTU, so
   * callers are not forced to think about fragments.
   *
   * An earlier version of this comment said the host checks snapshots against
   * the single-write size instead, on the grounds that a snapshot needing two
   * writes could tear across a frame boundary. It did not -- `MatchHost` has
   * only ever checked `maxPayload` -- and the tear it feared was a real
   * property of the framer, which is now fixed there rather than worked around
   * here. See BleFramer. Crossing a frame boundary is ordinary.
   */
  get maxPayload(): number {
    return this.adapter.payloadSize * 128;
  }

  /**
   * Payload that fits one BLE write, with no fragmentation.
   *
   * Nothing in the send path consults this -- it is here so tests can state
   * what actually fits a write, which is the number that decides whether the
   * hot path fragments at all.
   */
  get singleWritePayload(): number {
    return this.adapter.payloadSize;
  }

  setEvents(events: Partial<TransportEvents>): void {
    // Merge, not replace -- see the contract on Transport.setEvents. A lobby
    // patching in onPeerJoin must not unhook MatchHost's onPacket.
    this.events = { ...this.events, ...events };
  }

  async host(matchName: string): Promise<void> {
    await this.adapter.startAdvertising(matchName);
  }

  async discover(): Promise<void> {
    await this.adapter.startScanning((peer) => {
      this.events.onPeerJoin?.(peer);
    });
  }

  async join(peerId: PeerId): Promise<void> {
    await this.adapter.stopScanning();
    await this.adapter.connect(peerId);
  }

  send(to: PeerId, data: Uint8Array, reliable: boolean): void {
    try {
      for (const frame of this.framer.fragment(data)) {
        this.adapter.sendFrame(to, frame, reliable);
      }
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  broadcast(data: Uint8Array, reliable: boolean): void {
    // Fragment once, send the same frames to everyone. Re-fragmenting per peer
    // would burn a message id per recipient and roll the counter 4x faster.
    let frames: Uint8Array[];
    try {
      frames = this.framer.fragment(data);
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const peerId of this.peers.keys()) {
      for (const frame of frames) this.adapter.sendFrame(peerId, frame, reliable);
    }
  }

  async close(): Promise<void> {
    await this.adapter.stopScanning().catch(() => {});
    await this.adapter.stopAdvertising().catch(() => {});
    for (const peerId of this.peers.keys()) {
      await this.adapter.disconnect(peerId).catch(() => {});
    }
    this.peers.clear();
  }
}
