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
 */
export class BleFramer {
  private nextMessageId = 0;
  /** peerId -> messageId -> fragments received so far. */
  private pending = new Map<PeerId, Map<number, (Uint8Array | undefined)[]>>();

  constructor(private payloadSize: number = BLE_SAFE_MTU - FRAME_HEADER_BYTES) {
    if (this.payloadSize < 8) throw new Error(`BLE payload size ${this.payloadSize} is unusably small`);
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

    if (last && index === 0) return payload.slice();

    let byPeer = this.pending.get(from);
    if (!byPeer) {
      byPeer = new Map();
      this.pending.set(from, byPeer);
    }

    let parts = byPeer.get(id);
    if (!parts) {
      parts = [];
      byPeer.set(id, parts);
      // A partial message whose remaining fragments were dropped would sit here
      // forever. Message ids roll over every 256 sends, so bound the buffer
      // rather than tracking timers we would have to drive from somewhere.
      if (byPeer.size > 8) {
        const oldest = byPeer.keys().next().value;
        if (oldest !== undefined) byPeer.delete(oldest);
      }
    }
    parts[index] = payload.slice();

    if (!last) return null;

    // Last fragment seen: we know the count, so check we have all of them.
    const total = index + 1;
    let size = 0;
    for (let i = 0; i < total; i++) {
      const p = parts[i];
      if (!p) return null; // a fragment was lost; drop the whole message
      size += p.length;
    }

    const out = new Uint8Array(size);
    let offset = 0;
    for (let i = 0; i < total; i++) {
      out.set(parts[i]!, offset);
      offset += parts[i]!.length;
    }
    byPeer.delete(id);
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
    this.framer = new BleFramer(adapter.payloadSize);

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
   * callers are not forced to think about fragments. The host still checks its
   * snapshots against the single-write size, because a snapshot that needs two
   * writes can tear across a frame boundary.
   */
  get maxPayload(): number {
    return this.adapter.payloadSize * 128;
  }

  /** Payload that fits one BLE write, with no fragmentation. */
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
