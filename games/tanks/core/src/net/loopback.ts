/**
 * In-process transport with a simulated link.
 *
 * This exists to make netcode testable without a radio. Real Bluetooth is a
 * hostile link -- tens of milliseconds of latency, jitter, and genuine packet
 * loss -- and netcode that is only ever exercised over a perfect in-memory
 * channel will fall apart the first time it meets one. So this transport can
 * simulate all three, deterministically.
 *
 * Deterministically matters: loss patterns are drawn from a seeded Rng, not
 * Math.random, so a test that catches a desync fails the same way every run.
 * A flaky netcode test is worse than no netcode test.
 */

import { Rng } from '../math.js';
import {
  TransportKind,
  type Peer,
  type PeerId,
  type Transport,
  type TransportEvents,
} from '@lan-party/net';

export interface LinkProfile {
  /** One-way latency in ms. */
  latencyMs: number;
  /** Random additional latency in ms, uniform in [0, jitterMs]. */
  jitterMs: number;
  /** Probability in [0, 1] that an unreliable packet is dropped. */
  loss: number;
  /** Bytes per second. 0 disables the bandwidth model. */
  bandwidth: number;
}

/** Roughly what raw BLE GATT gives you with several links up. */
export const BLE_PROFILE: LinkProfile = {
  latencyMs: 45,
  jitterMs: 30,
  loss: 0.03,
  bandwidth: 4000,
};

/** A good local WiFi link. */
export const LAN_PROFILE: LinkProfile = {
  latencyMs: 6,
  jitterMs: 4,
  loss: 0.001,
  bandwidth: 200000,
};

export const PERFECT_PROFILE: LinkProfile = {
  latencyMs: 0,
  jitterMs: 0,
  loss: 0,
  bandwidth: 0,
};

interface InFlight {
  from: PeerId;
  to: PeerId;
  data: Uint8Array;
  reliable: boolean;
  /** Virtual ms at which this packet is delivered. */
  arriveAt: number;
}

/**
 * The shared medium. Tests create one of these, attach several transports, and
 * advance virtual time by hand -- so a 60-second match runs in milliseconds and
 * always produces the same result.
 */
export class LoopbackNetwork {
  private endpoints = new Map<PeerId, LoopbackTransport>();
  private queue: InFlight[] = [];
  private rng: Rng;
  private nowMs = 0;
  /** Per-link byte budget carried between pumps, for the bandwidth model. */
  private sendBudget = new Map<PeerId, number>();

  droppedPackets = 0;
  deliveredPackets = 0;
  deliveredBytes = 0;

  constructor(
    public profile: LinkProfile = PERFECT_PROFILE,
    seed = 1,
  ) {
    this.rng = new Rng(seed);
  }

  get now(): number {
    return this.nowMs;
  }

  attach(t: LoopbackTransport): void {
    this.endpoints.set(t.id, t);
  }

  connect(a: PeerId, b: PeerId): void {
    const ta = this.endpoints.get(a);
    const tb = this.endpoints.get(b);
    if (!ta || !tb) throw new Error('connect: unknown endpoint');
    ta.notifyJoin({ id: b, name: tb.name, rtt: this.profile.latencyMs * 2 });
    tb.notifyJoin({ id: a, name: ta.name, rtt: this.profile.latencyMs * 2 });
  }

  submit(from: PeerId, to: PeerId, data: Uint8Array, reliable: boolean): void {
    const p = this.profile;

    // Unreliable packets can vanish. Reliable ones are modelled as always
    // arriving, but late -- which is what a retransmit actually looks like from
    // the application's point of view.
    if (!reliable && p.loss > 0 && this.rng.next() < p.loss) {
      this.droppedPackets++;
      return;
    }

    let delay = p.latencyMs + (p.jitterMs > 0 ? this.rng.range(0, p.jitterMs) : 0);
    if (!reliable) {
      // Nothing more to add.
    } else if (p.loss > 0 && this.rng.next() < p.loss) {
      // Simulate one retransmit round trip.
      delay += p.latencyMs * 2 + 15;
    }

    if (p.bandwidth > 0) {
      // Serialisation delay: a 180-byte write on a 4 KB/s link is ~45ms of
      // airtime, and that queueing is a real effect on BLE, not a rounding
      // error. Model it by carrying a per-sender busy-until timestamp.
      const busyUntil = this.sendBudget.get(from) ?? 0;
      const airtime = (data.length / p.bandwidth) * 1000;
      const startAt = Math.max(this.nowMs, busyUntil);
      this.sendBudget.set(from, startAt + airtime);
      delay += startAt - this.nowMs + airtime;
    }

    this.queue.push({ from, to, data, reliable, arriveAt: this.nowMs + delay });
  }

  /** Advance virtual time, delivering everything that has come due. */
  advance(ms: number): void {
    this.nowMs += ms;
    if (this.queue.length === 0) return;

    // Deliver in arrival order. Note this does NOT guarantee send order --
    // jitter genuinely reorders packets on a real link, and the protocol has
    // to tolerate that.
    const due = this.queue.filter((p) => p.arriveAt <= this.nowMs);
    if (due.length === 0) return;
    this.queue = this.queue.filter((p) => p.arriveAt > this.nowMs);
    due.sort((a, b) => a.arriveAt - b.arriveAt);

    for (const p of due) {
      const target = this.endpoints.get(p.to);
      if (!target) continue;
      this.deliveredPackets++;
      this.deliveredBytes += p.data.length;
      target.notifyPacket(p.from, p.data);
    }
  }
}

export class LoopbackTransport implements Transport {
  readonly kind = TransportKind.Loopback;
  /** Matches the conservative BLE ceiling so tests catch oversized packets. */
  readonly maxPayload = 180;

  private events: Partial<TransportEvents> = {};
  private peers = new Set<PeerId>();

  constructor(
    readonly id: PeerId,
    readonly name: string,
    private network: LoopbackNetwork,
  ) {
    network.attach(this);
  }

  setEvents(events: Partial<TransportEvents>): void {
    // Merge, not replace -- see the contract on Transport.setEvents. A lobby
    // patching in onPeerJoin must not unhook MatchHost's onPacket.
    this.events = { ...this.events, ...events };
  }

  async host(): Promise<void> {}
  async discover(): Promise<void> {}
  async join(peerId: PeerId): Promise<void> {
    this.peers.add(peerId);
  }

  send(to: PeerId, data: Uint8Array, reliable: boolean): void {
    if (data.length > this.maxPayload) {
      this.events.onError?.(
        new Error(`payload ${data.length}B exceeds the ${this.maxPayload}B transport limit`),
      );
      return;
    }
    this.network.submit(this.id, to, data, reliable);
  }

  broadcast(data: Uint8Array, reliable: boolean): void {
    for (const p of this.peers) this.send(p, data, reliable);
  }

  async close(): Promise<void> {
    this.peers.clear();
  }

  notifyJoin(peer: Peer): void {
    this.peers.add(peer.id);
    this.events.onPeerJoin?.(peer);
  }

  notifyPacket(from: PeerId, data: Uint8Array): void {
    this.events.onPacket?.(from, data);
  }
}
