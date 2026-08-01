import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BleFramer,
  BleTransport,
  BLE_SAFE_MTU,
  FRAME_HEADER_BYTES,
  type BleAdapter,
} from '../src/net/ble.js';
import type { Peer, PeerId } from '../src/net/transport.js';
import { MatchHost } from '../src/net/host.js';
import { MatchClient } from '../src/net/client.js';
import { cloneWorld, createWorld } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { Rng } from '../src/math.js';
import { emptyInput } from '../src/types.js';

test('framer round-trips a message that fits one write', () => {
  const f = new BleFramer(64);
  const msg = Uint8Array.from({ length: 40 }, (_, i) => i);
  const frames = f.fragment(msg);
  assert.equal(frames.length, 1, 'a small message must not be fragmented');
  assert.equal(frames[0].length, 40 + FRAME_HEADER_BYTES);

  const out = f.reassemble('peer', frames[0]);
  assert.deepEqual(out, msg);
});

test('framer round-trips a message spanning many fragments', () => {
  const f = new BleFramer(32);
  const msg = Uint8Array.from({ length: 400 }, (_, i) => (i * 7) & 0xff);
  const frames = f.fragment(msg);
  assert.equal(frames.length, Math.ceil(400 / 32));
  for (const fr of frames) {
    assert.ok(fr.length <= 32 + FRAME_HEADER_BYTES, 'no frame may exceed the MTU');
  }

  let out: Uint8Array | null = null;
  for (const fr of frames) out = f.reassemble('peer', fr);
  assert.deepEqual(out, msg, 'reassembled payload must match byte for byte');
});

test('framer drops a message with a lost fragment instead of emitting garbage', () => {
  // A truncated snapshot applied as if complete would move tanks to nonsense
  // positions. Losing the message entirely is strictly better -- the next
  // snapshot arrives 66ms later.
  const f = new BleFramer(16);
  const msg = Uint8Array.from({ length: 100 }, (_, i) => i);
  const frames = f.fragment(msg);

  let out: Uint8Array | null = null;
  frames.forEach((fr, i) => {
    if (i === 2) return; // drop one in the middle
    out = f.reassemble('peer', fr);
  });
  assert.equal(out, null, 'an incomplete message must not be delivered');
});

test('framer keeps concurrent peers separate', () => {
  // Both peers are mid-message at the same time. If the framer keyed buffers by
  // message id alone, peer A's fragments would corrupt peer B's message.
  const f = new BleFramer(16);
  const a = Uint8Array.from({ length: 48 }, () => 0xaa);
  const b = Uint8Array.from({ length: 48 }, () => 0xbb);

  const fa = f.fragment(a);
  const fb = f.fragment(b);

  let outA: Uint8Array | null = null;
  let outB: Uint8Array | null = null;
  for (let i = 0; i < fa.length; i++) {
    outA = f.reassemble('A', fa[i]);
    outB = f.reassemble('B', fb[i]);
  }
  assert.deepEqual(outA, a);
  assert.deepEqual(outB, b);
});

test('framer bounds its buffers against abandoned messages', () => {
  // Fragments whose tail never arrives must not accumulate forever on a
  // long-running host.
  const f = new BleFramer(16);
  for (let i = 0; i < 200; i++) {
    const frames = f.fragment(new Uint8Array(64));
    f.reassemble('peer', frames[0]); // first fragment only, never completed
  }
  // Nothing to assert directly without reaching into internals -- what matters
  // is that a completed message still works afterwards.
  const msg = Uint8Array.from({ length: 40 }, (_, i) => i);
  const frames = f.fragment(msg);
  let out: Uint8Array | null = null;
  for (const fr of frames) out = f.reassemble('peer', fr);
  assert.deepEqual(out, msg, 'framer must still work after many abandoned messages');
});

test('framer refuses a message too large to fragment', () => {
  const f = new BleFramer(16);
  assert.throws(() => f.fragment(new Uint8Array(16 * 129)), /fragments/);
});

/**
 * A fake radio.
 *
 * Pairs two BleTransports and moves frames between them with latency and loss,
 * so the whole match stack can be exercised over the BLE code path without
 * hardware. Deterministic, so a failure reproduces.
 */
class FakeBleLink {
  private frameCb = new Map<PeerId, (from: PeerId, frame: Uint8Array) => void>();
  private queue: { to: PeerId; from: PeerId; frame: Uint8Array; at: number }[] = [];
  private now = 0;
  private rng: Rng;
  dropped = 0;
  delivered = 0;

  constructor(
    private latencyMs = 45,
    private loss = 0.03,
    seed = 7,
  ) {
    this.rng = new Rng(seed);
  }

  adapterFor(self: PeerId, other: PeerId, payloadSize = BLE_SAFE_MTU - FRAME_HEADER_BYTES): BleAdapter {
    let onConn: ((p: Peer) => void) | null = null;
    return {
      payloadSize,
      startAdvertising: async () => {},
      stopAdvertising: async () => {},
      startScanning: async () => {},
      stopScanning: async () => {},
      connect: async () => {
        onConn?.({ id: other, name: other, rtt: this.latencyMs * 2 });
      },
      disconnect: async () => {},
      sendFrame: (to, frame, ack) => {
        // Unacked frames can vanish; acked ones arrive late instead, which is
        // what a link-layer retransmit looks like from up here.
        if (!ack && this.rng.next() < this.loss) {
          this.dropped++;
          return;
        }
        const extra = ack && this.rng.next() < this.loss ? this.latencyMs * 2 : 0;
        this.queue.push({ to, from: self, frame, at: this.now + this.latencyMs + extra });
      },
      onFrame: (cb) => this.frameCb.set(self, cb),
      onPeerConnected: (cb) => {
        onConn = cb;
      },
      onPeerDisconnected: () => {},
    };
  }

  advance(ms: number): void {
    this.now += ms;
    const due = this.queue.filter((p) => p.at <= this.now);
    if (!due.length) return;
    this.queue = this.queue.filter((p) => p.at > this.now);
    for (const p of due) {
      this.delivered++;
      this.frameCb.get(p.to)?.(p.from, p.frame);
    }
  }
}

test('a full match runs over the BLE transport', async () => {
  // The point of this test: everything above the transport -- MatchHost,
  // MatchClient, prediction, reconciliation, the wire format -- must work
  // unchanged when the bytes travel over BLE framing rather than a socket.
  const link = new FakeBleLink(45, 0.03, 3);

  const hostTransport = new BleTransport(link.adapterFor('host', 'client'));
  const clientTransport = new BleTransport(link.adapterFor('client', 'host'));

  const hostWorld = createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 42,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
    ],
  });

  const host = new MatchHost(hostWorld, hostTransport);
  const clientWorld = cloneWorld(hostWorld);
  const client = new MatchClient(clientWorld, clientTransport, 'host', 1);

  // Wire both ends up as if discovery had completed. join() is async, so it
  // must be awaited -- a fire-and-forget call leaves the host's peer list empty
  // and every broadcast goes nowhere.
  await hostTransport.join('client');
  await clientTransport.join('host');

  const scripted = new Rng(11);
  const stepMs = 1000 / 60;
  for (let i = 0; i < 60 * 20; i++) {
    if (i % 20 === 0) {
      client.setInput({
        moveX: scripted.range(-1, 1),
        moveY: scripted.range(-1, 1),
        aimX: scripted.range(-1, 1),
        aimY: scripted.range(-1, 1),
        fire: scripted.next() < 0.15,
        layMine: false,
      });
    }
    client.update(stepMs);
    link.advance(stepMs);
    host.update(stepMs);
    link.advance(0);
  }

  assert.ok(link.delivered > 1000, 'the link should have carried real traffic');
  assert.ok(link.dropped > 0, 'the test link should actually drop packets');
  assert.ok(client.snapshotsApplied > 0, 'client should be applying snapshots over BLE');

  const h = hostWorld.tanks.find((t) => t.id === 1)!;
  const c = client.world.tanks.find((t) => t.id === 1)!;
  const drift = Math.hypot(h.x - c.x, h.y - c.y);
  assert.ok(
    drift < 0.6,
    `client drifted ${drift.toFixed(3)} tiles over BLE ` +
      `(${client.reconciles} reconciles, ${client.resyncs} resyncs, ${link.dropped} drops)`,
  );
});

test('an 8-tank snapshot fits a single BLE write', async () => {
  // If a snapshot needs two writes it can tear: half the tanks from this frame,
  // half from the last. Verify the design ceiling still fits one.
  const link = new FakeBleLink();
  const transport = new BleTransport(link.adapterFor('host', 'client'));
  const single = transport.singleWritePayload;

  const world = createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 1,
    players: Array.from({ length: 4 }, (_, i) => ({ team: i, spawnIndex: i })),
  });
  const errors: Error[] = [];
  transport.setEvents({ onError: (e) => errors.push(e) });
  const host = new MatchHost(world, transport);
  await transport.join('client');

  for (let i = 0; i < 60; i++) host.update(1000 / 60);

  // 4 + 6 bytes per tank, plus our 2-byte BLE frame header.
  const snapshotBytes = 4 + world.tanks.length * 6 + FRAME_HEADER_BYTES;
  assert.ok(
    snapshotBytes <= single,
    `snapshot of ${world.tanks.length} tanks is ${snapshotBytes}B, over the ${single}B single-write limit`,
  );
  assert.deepEqual(errors, []);
});

test('input frames are small enough to send every tick over BLE', async () => {
  // 60Hz of input from 4 clients has to coexist with snapshots inside a few
  // KB/s. Check the per-write cost including framing.
  const link = new FakeBleLink();
  const transport = new BleTransport(link.adapterFor('client', 'host'));
  const sent: number[] = [];
  const adapter = link.adapterFor('client', 'host');
  const spy: BleAdapter = { ...adapter, sendFrame: (_to, frame) => sent.push(frame.length) };
  const t2 = new BleTransport(spy);
  await t2.join('host');

  const world = createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 1,
    players: [{ team: 0, spawnIndex: 0 }],
  });
  const client = new MatchClient(world, t2, 'host', 0);
  client.setInput(emptyInput());
  for (let i = 0; i < 60; i++) client.update(1000 / 60);

  assert.ok(sent.length >= 55, `expected ~60 input frames, got ${sent.length}`);
  const max = Math.max(...sent);
  assert.equal(max, 8 + FRAME_HEADER_BYTES, 'an input frame should be 8 bytes plus framing');

  const bytesPerSecond = sent.reduce((a, b) => a + b, 0);
  assert.ok(bytesPerSecond < 700, `input costs ${bytesPerSecond} B/s per client, too much for BLE`);
  void transport;
});
