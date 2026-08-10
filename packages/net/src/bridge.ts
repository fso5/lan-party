/**
 * Transport adapter for any environment-provided message channel.
 *
 * WebSockets, BLE characteristics and UDP sockets all have completely
 * different APIs for the same two operations: hand these bytes to that peer,
 * and tell me when bytes arrive. Rather than write a Transport implementation
 * per environment -- each duplicating the same bookkeeping and each a separate
 * place for bugs to hide -- this class takes a send callback and exposes a
 * receive method, and the environment-specific glue stays outside `core`.
 *
 * That keeps `core` free of any dependency on `ws`, on a BLE library, or on
 * browser globals, which is what lets the same package run in Node tests, in a
 * browser, and in React Native without conditional imports.
 */

import {
  TransportKind,
  type Peer,
  type PeerId,
  type Transport,
  type TransportEvents,
} from './transport.js';

export interface BridgeOptions {
  /**
   * Largest payload the underlying channel accepts. Defaults to the
   * conservative BLE ceiling so code developed over WebSockets does not
   * silently rely on packet sizes a radio will refuse.
   */
  maxPayload?: number;
  kind?: TransportKind;
}

export class BridgeTransport implements Transport {
  readonly kind: TransportKind;
  readonly maxPayload: number;

  private events: Partial<TransportEvents> = {};
  private peers = new Map<PeerId, Peer>();

  constructor(
    /** Hands bytes to a peer. Throwing here is reported through onError. */
    private sendFn: (to: PeerId, data: Uint8Array, reliable: boolean) => void,
    options: BridgeOptions = {},
  ) {
    this.maxPayload = options.maxPayload ?? 180;
    this.kind = options.kind ?? TransportKind.Loopback;
  }

  setEvents(events: Partial<TransportEvents>): void {
    // Merge, not replace -- see the contract on Transport.setEvents. A lobby
    // patching in onPeerJoin must not unhook MatchHost's onPacket.
    this.events = { ...this.events, ...events };
  }

  async host(): Promise<void> {}
  async discover(): Promise<void> {}
  async join(peerId: PeerId): Promise<void> {
    this.addPeer({ id: peerId, name: peerId, rtt: -1 });
  }

  send(to: PeerId, data: Uint8Array, reliable: boolean): void {
    if (data.length > this.maxPayload) {
      this.events.onError?.(
        new Error(`payload ${data.length}B exceeds the ${this.maxPayload}B transport limit`),
      );
      return;
    }
    try {
      this.sendFn(to, data, reliable);
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  broadcast(data: Uint8Array, reliable: boolean): void {
    for (const id of this.peers.keys()) this.send(id, data, reliable);
  }

  async close(): Promise<void> {
    this.peers.clear();
  }

  // --- Called by the environment glue ------------------------------------

  addPeer(peer: Peer): void {
    this.peers.set(peer.id, peer);
    this.events.onPeerJoin?.(peer);
  }

  removePeer(peerId: PeerId, reason = 'disconnected'): void {
    if (!this.peers.delete(peerId)) return;
    this.events.onPeerLeave?.(peerId, reason);
  }

  receive(from: PeerId, data: Uint8Array): void {
    this.events.onPacket?.(from, data);
  }

  get peerIds(): PeerId[] {
    return [...this.peers.keys()];
  }
}
