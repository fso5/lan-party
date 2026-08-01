/**
 * Transport abstraction.
 *
 * The game never talks to Bluetooth directly. It talks to this interface, and
 * we provide several implementations:
 *
 *   BleTransport       raw BLE GATT. The only option that works iPhone <-> Android,
 *                      so it is the one cross-play depends on. ~2-8 KB/s usable,
 *                      MTU around 185 bytes on iOS. Star topology only.
 *   LanTransport       UDP over a shared WiFi network or a hotspot. An order of
 *                      magnitude more headroom; used automatically when peers
 *                      discover they are on the same network.
 *   LoopbackTransport  in-process, for tests and for running host+client in one
 *                      app during development.
 *
 * Two rules the implementations must honour, because the netcode above depends
 * on them:
 *
 *   - `send` is unreliable and unordered by default. Anything that must arrive
 *     goes through the reliable flag, which layers a small ack/retransmit
 *     scheme on top. State snapshots are deliberately unreliable: a dropped
 *     snapshot is replaced by a newer one 66ms later, and retransmitting stale
 *     positions would waste the budget we do not have.
 *   - Packets are delivered whole or not at all. No partial frames.
 */

export type PeerId = string;

export interface Peer {
  id: PeerId;
  name: string;
  /** Round-trip time estimate in ms, or -1 until measured. */
  rtt: number;
}

export enum TransportKind {
  Ble = 'ble',
  Lan = 'lan',
  Loopback = 'loopback',
}

export interface TransportEvents {
  onPeerJoin(peer: Peer): void;
  onPeerLeave(peerId: PeerId, reason: string): void;
  onPacket(from: PeerId, data: Uint8Array): void;
  onError(err: Error): void;
}

export interface Transport {
  readonly kind: TransportKind;
  /**
   * Largest payload `send` accepts. BLE is the constraint here -- treat this as
   * a hard ceiling, not a hint, and never assume more than 180 bytes.
   */
  readonly maxPayload: number;

  /** Begin advertising as a host under this match name. */
  host(matchName: string): Promise<void>;
  /** Begin scanning. Discovered hosts arrive via onPeerJoin. */
  discover(): Promise<void>;
  join(peerId: PeerId): Promise<void>;

  send(to: PeerId, data: Uint8Array, reliable: boolean): void;
  broadcast(data: Uint8Array, reliable: boolean): void;

  close(): Promise<void>;

  /**
   * Patch handlers. **Merges** -- handlers you do not name are left alone.
   *
   * This has to merge, because the things that register handlers do not know
   * about each other. `MatchHost` takes `onPacket` in its constructor; a lobby
   * showing discovered phones takes `onPeerJoin`. Under replace semantics the
   * lobby's perfectly ordinary call silently unhooks the host's packet
   * delivery, and the symptom is a radio that goes quiet with no error --
   * indistinguishable from the other phone not being there.
   *
   * To clear a handler, name it explicitly: `setEvents({ onPacket: undefined })`.
   *
   * Merging fixes handlers on *different* keys, which is the common case. Two
   * owners of the *same* key is still last-one-wins, and there is no way for a
   * single slot to be otherwise -- if a lobby needs `onPacket` while a match is
   * running, it owns dispatch and forwards to the public `handlePacket` on
   * `MatchHost`/`MatchClient`, with `removeClient` for the leave path.
   */
  setEvents(events: Partial<TransportEvents>): void;
}
