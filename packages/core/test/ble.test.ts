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

test('a stale fragment is not spliced into the message that reuses its id', () => {
  // The message id is one byte, so it repeats every 256 sends -- seventeen
  // seconds at snapshot rate. Before this was fixed, an abandoned message's
  // surviving fragments were still buffered under that id when it came round,
  // and the two messages were handed up as one: 18 bytes of the old snapshot
  // and 10 bytes of the new, indistinguishable from a real one.
  //
  // Sender and receiver are separate framers here because that is how the
  // stack runs -- the host fragments, the client reassembles.
  const sender = new BleFramer(18);
  const receiver = new BleFramer(18);

  const old = Uint8Array.from({ length: 28 }, () => 0xaa);
  const fresh = Uint8Array.from({ length: 28 }, () => 0xbb);

  const framesOld = sender.fragment(old);
  assert.equal(framesOld.length, 2, 'the message under test has to fragment');
  assert.equal(receiver.reassemble('peer', framesOld[0]), null);
  // framesOld[1] is lost, leaving the first fragment behind.

  // Roll the id all the way round. Only one of the 255 is delivered, which is
  // the whole margin the fix needs and worth stating as such: a message
  // arriving between two fragments proves the first was abandoned.
  //
  // The limit, since it cannot be tested away: if every one of the 255 were
  // lost too, the receiver's entire input would be a first fragment under id
  // 0 and a last fragment under id 0, which is byte-identical to a legitimate
  // pair. Nothing can separate them without a wider id, and a wider id costs a
  // byte of every frame on a 20-byte budget to insure against 255 consecutive
  // total losses on a link that would be dead anyway.
  for (let i = 0; i < 255; i++) {
    const filler = sender.fragment(new Uint8Array(1));
    if (i === 120) receiver.reassemble('peer', filler[0]);
  }

  const framesFresh = sender.fragment(fresh);
  assert.equal(framesFresh[0][0], framesOld[0][0], 'the ids must actually collide');
  // This time the *first* fragment is the one lost.
  const out = receiver.reassemble('peer', framesFresh[1]);

  assert.equal(out, null, 'a message missing its first fragment must be dropped, not completed');
});

test('a whole message abandons a half-assembled one from the same peer', () => {
  // What makes the id-reuse fix airtight rather than merely narrow: fragments
  // of one message are written back to back, so anything complete arriving
  // between them proves the held message is never finishing.
  const f = new BleFramer(18);
  const big = Uint8Array.from({ length: 28 }, () => 0xaa);
  const small = Uint8Array.from({ length: 8 }, () => 0xcc);

  const framesBig = f.fragment(big);
  const framesSmall = f.fragment(small);
  assert.equal(framesSmall.length, 1);

  assert.equal(f.reassemble('peer', framesBig[0]), null);
  assert.deepEqual(f.reassemble('peer', framesSmall[0]), small, 'the whole message arrives intact');
  assert.equal(
    f.reassemble('peer', framesBig[1]),
    null,
    'the interrupted message must not complete afterwards',
  );
});

test('the message after an abandoned one still arrives whole', () => {
  // The direction that matters more than any of the dropping: on a link that
  // loses a fragment, the *next* fragmented message has to be unaffected. A
  // reassembler that held on to the wreckage of the last one would take the
  // rest of the match down with it.
  const f = new BleFramer(18);
  const lost = Uint8Array.from({ length: 46 }, () => 0xaa);
  const good = Uint8Array.from({ length: 46 }, (_, i) => i);

  const framesLost = f.fragment(lost);
  assert.equal(framesLost.length, 3);
  f.reassemble('peer', framesLost[0]);
  f.reassemble('peer', framesLost[1]);
  // framesLost[2] never arrives.

  const framesGood = f.fragment(good);
  let out: Uint8Array | null = null;
  for (const fr of framesGood) out = f.reassemble('peer', fr);
  assert.deepEqual(out, good, 'a clean message must not inherit the last one’s failure');
});

test('a fragment of another message does not complete the one being held', () => {
  // The same proof by a different route: the interleaving frame is itself a
  // fragment rather than a whole message.
  const f = new BleFramer(18);
  const a = Uint8Array.from({ length: 28 }, () => 0xaa);
  const b = Uint8Array.from({ length: 28 }, () => 0xbb);

  const fa = f.fragment(a);
  const fb = f.fragment(b);

  assert.equal(f.reassemble('peer', fa[0]), null);
  assert.equal(f.reassemble('peer', fb[1]), null, 'b is missing its own first fragment');
  assert.equal(f.reassemble('peer', fa[1]), null, 'a was abandoned and must not complete');
});

test('framer refuses a message too large to fragment', () => {
  const f = new BleFramer(16);
  assert.throws(() => f.fragment(new Uint8Array(16 * 129)), /fragments/);
});

test('an MTU agreed after connecting reaches the fragmenter', () => {
  // A BLE MTU is negotiated once the link is up, which is necessarily after
  // the transport was built. Reading the adapter's payload size once, in the
  // constructor, therefore captures the conservative default and keeps it for
  // the whole match: measured at ten fragments for a 180-byte message on a
  // link that had agreed to carry it in one. Ten times the writes and ten
  // times the header on the budget this protocol is shaped around, and
  // nothing anywhere reports it -- the transport goes on advertising the
  // larger size it is not using.
  let payload = 18;
  const sent: Uint8Array[] = [];
  // An array rather than a nullable binding: assigning through a callback does
  // not tell the compiler the value is set, and it narrows to null.
  const connected: ((p: Peer) => void)[] = [];

  const adapter: BleAdapter = {
    get payloadSize() {
      return payload;
    },
    startAdvertising: async () => {},
    stopAdvertising: async () => {},
    startScanning: async () => {},
    stopScanning: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    sendFrame: (_to, frame) => sent.push(frame),
    onFrame: () => {},
    onPeerConnected: (cb) => {
      connected.push(cb);
    },
    onPeerDisconnected: () => {},
  };

  const transport = new BleTransport(adapter);
  const message = new Uint8Array(180);

  transport.send('p1', message, false);
  assert.equal(sent.length, 10, 'before anything is negotiated it should fragment at the floor');

  sent.length = 0;
  payload = 183;
  connected[0]({ id: 'p1', name: 'p1', rtt: -1 });
  transport.send('p1', message, false);
  assert.equal(sent.length, 1, 'once the link has agreed a bigger write, one fragment');

  // And back down again, because a late renegotiation can shrink it.
  sent.length = 0;
  payload = 40;
  transport.send('p1', message, false);
  assert.equal(sent.length, 5, 'a shrinking MTU has to be followed too');
});

test('a live payload size below the BLE minimum is refused, not fragmented around', () => {
  // Without this the message still fails, but as "needs 180 fragments, max
  // 128" -- which points at the message rather than at the radio that just
  // reported something impossible.
  const f = new BleFramer(() => 4);
  assert.throws(() => f.fragment(new Uint8Array(180)), /unusably small/);
});

test('the size the transport advertises is the one it fragments against', () => {
  // These come from the same place now. When they did not, `maxPayload` said a
  // message was acceptable and `fragment` then refused it for needing more
  // than 128 fragments -- a message rejected by the layer that had just
  // approved it.
  let payload = 18;
  const adapter = {
    get payloadSize() {
      return payload;
    },
    startAdvertising: async () => {},
    stopAdvertising: async () => {},
    startScanning: async () => {},
    stopScanning: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    sendFrame: () => {},
    onFrame: () => {},
    onPeerConnected: () => {},
    onPeerDisconnected: () => {},
  } satisfies BleAdapter;

  const transport = new BleTransport(adapter);
  for (payload of [18, 40, 183]) {
    assert.equal(transport.maxPayload, transport.singleWritePayload * 128);
    assert.doesNotThrow(() => new BleFramer(() => payload).fragment(new Uint8Array(transport.maxPayload)));
  }
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

/**
 * A BLE adapter whose connection outcome the test decides.
 *
 * The FakeBleLink above connects synchronously inside `connect()`, which is the
 * happy path and cannot express the interesting one: `connectGatt` returning
 * while no link is ever established.
 */
function controllableAdapter() {
  let onConn: ((p: Peer) => void) | null = null;
  let onDisc: ((id: PeerId, reason: string) => void) | null = null;
  // A holder rather than a bare `let`: assigned only inside a callback, TS
  // narrows a `T | null` variable to null at the return site below.
  const hooks: { frame?: (from: PeerId, frame: Uint8Array) => void } = {};
  // A platform can only refuse a connection it was asked for. `join` awaits
  // stopScanning before it registers anything, so a test that fires the outcome
  // synchronously is describing an order that cannot happen -- and gets a
  // misleading failure. Waiting on this keeps the test honest about causality.
  let asked: () => void;
  const wasAsked = new Promise<void>((r) => {
    asked = r;
  });
  const adapter: BleAdapter = {
    payloadSize: 18,
    startAdvertising: async () => {},
    stopAdvertising: async () => {},
    startScanning: async () => {},
    stopScanning: async () => {},
    // Resolves immediately and does nothing else, exactly as `connectGatt` does.
    connect: async () => {
      asked();
    },
    disconnect: async () => {},
    sendFrame: () => {},
    onFrame: (cb) => {
      hooks.frame = cb;
    },
    onPeerConnected: (cb) => {
      onConn = cb;
    },
    onPeerDisconnected: (cb) => {
      onDisc = cb;
    },
  };
  return {
    adapter,
    wasAsked,
    connects: (id: PeerId) => onConn?.({ id, name: id, rtt: 40 }),
    fails: (id: PeerId, reason: string) => onDisc?.(id, reason),
    deliver: (from: PeerId, frame: Uint8Array) => hooks.frame?.(from, frame),
  };
}

test('join does not report success for a connection that never came up', async () => {
  // The bug this pins: `adapter.connect` resolving means the platform accepted
  // the request, not that a link exists. `await join(...)` used to resolve
  // cleanly here and the caller had no way to tell it had not worked.
  const { adapter } = controllableAdapter();
  const transport = new BleTransport(adapter);

  await assert.rejects(
    () => transport.join('host', 25),
    /no answer from host/,
    'a join nothing answered must fail rather than resolve',
  );
});

test('a join that times out names both plausible causes', async () => {
  // Whoever reads this message is standing in a room holding a phone. Range and
  // a full host are the two things they can actually act on, and the client
  // cannot tell which it is -- so it must not pick one.
  const { adapter } = controllableAdapter();
  const transport = new BleTransport(adapter);

  await assert.rejects(
    () => transport.join('host', 25),
    (err: Error) =>
      /out of range/.test(err.message) && /connections as its Bluetooth stack allows/.test(err.message),
  );
});

test('join fails with the reason when the platform refuses the connection', async () => {
  // Android delivers a refused connect as a state change to DISCONNECTED with a
  // status code -- 133 is the usual catch-all, and it is what a host already at
  // its connection limit produces.
  const { adapter, wasAsked, fails } = controllableAdapter();
  const transport = new BleTransport(adapter);

  const joining = transport.join('host', 5_000);
  await wasAsked;
  fails('host', 'status 133');

  await assert.rejects(joining, /could not connect to host: status 133/);
});

test('a connection that fails is not announced as a player leaving', async () => {
  // onPeerLeave means somebody who was in the match is no longer in it. Firing
  // it for a peer that never arrived would have a lobby remove a player it had
  // never shown, and a host retire a client it never had.
  const { adapter, wasAsked, fails } = controllableAdapter();
  const transport = new BleTransport(adapter);
  const departures: PeerId[] = [];
  transport.setEvents({ onPeerLeave: (id) => departures.push(id) });

  const joining = transport.join('host', 5_000);
  await wasAsked;
  fails('host', 'status 133');
  await assert.rejects(joining, /could not connect/);

  assert.deepEqual(departures, [], 'nobody left; the join failed');
});

test('a real departure is still announced after a successful join', async () => {
  // The guard above must key on "is a join pending", not on the peer id, or it
  // would swallow the genuine disconnect that follows a working connection.
  const { adapter, wasAsked, connects, fails } = controllableAdapter();
  const transport = new BleTransport(adapter);
  const departures: PeerId[] = [];
  transport.setEvents({ onPeerLeave: (id) => departures.push(id) });

  const joining = transport.join('host', 5_000);
  await wasAsked;
  connects('host');
  await joining;

  fails('host', 'left');
  assert.deepEqual(departures, ['host'], 'a peer that had connected did leave');
});

test('a departed peer takes its half-assembled message with it', () => {
  /*
   * Found by mutation: deleting the `forgetPeer` call from BleTransport's
   * disconnect handler broke nothing, and `forgetPeer` had no test of its own.
   *
   * Two things go wrong without it. The buffers of everyone who ever left stay
   * held, which on a phone hosting an evening of matches is a slow leak nobody
   * would attribute to the radio. And the ids are per-peer, so a new player
   * assigned a departed one's id can complete a stranger's message: the header
   * on a BLE address makes that unlikely rather than impossible, and the result
   * would be a snapshot spliced from two halves that both look valid.
   */
  const f = new BleFramer(18);
  const msg = Uint8Array.from({ length: 28 }, (_, i) => i);
  const frames = f.fragment(msg);
  assert.equal(frames.length, 2, 'the message under test has to fragment');

  assert.equal(f.reassemble('peer', frames[0]), null, 'first fragment is held');
  f.forgetPeer('peer');

  assert.equal(
    f.reassemble('peer', frames[1]),
    null,
    'the tail completed a message whose head should have left with the peer',
  );
});

test('forgetting one peer leaves everybody else alone', () => {
  // The other half: a forgetPeer that cleared the whole map would pass the test
  // above and drop a live player's message mid-reassembly.
  const f = new BleFramer(18);
  const a = Uint8Array.from({ length: 28 }, () => 0xaa);
  const b = Uint8Array.from({ length: 28 }, () => 0xbb);
  const fa = f.fragment(a);
  const fb = f.fragment(b);

  f.reassemble('A', fa[0]);
  f.reassemble('B', fb[0]);

  f.forgetPeer('A');

  assert.deepEqual(f.reassemble('B', fb[1]), b, 'B lost its message when A left');
});

test('a disconnect actually reaches the framer, not just the peer list', () => {
  /*
   * The wiring, as opposed to the method. The two tests above call
   * `forgetPeer` directly and pass whether or not BleTransport ever calls it --
   * deleting the call from the disconnect handler survived both, which is the
   * same shape of gap as testing a guard without testing that anything invokes
   * it.
   *
   * The scenario is ordinary rather than exotic: a phone drops mid-snapshot and
   * comes back. BLE peer ids are stable addresses, so the returning phone is
   * the same peer, and a head left over from before its disconnect would be
   * completed by a tail from after it.
   */
  const { adapter, deliver, fails } = controllableAdapter();
  const transport = new BleTransport(adapter);
  const packets: Uint8Array[] = [];
  transport.setEvents({ onPacket: (_from, data) => packets.push(data) });

  // payloadSize is 18 on this adapter, so 28 bytes is two fragments.
  const frames = new BleFramer(18).fragment(Uint8Array.from({ length: 28 }, (_, i) => i));
  assert.equal(frames.length, 2, 'the message under test has to fragment');

  deliver('host', frames[0]);
  assert.deepEqual(packets, [], 'half a message is not a packet');

  fails('host', 'link lost');
  deliver('host', frames[1]);

  assert.deepEqual(packets, [], 'the tail completed a message from before the disconnect');
});

/**
 * A packet the game cannot read must not take the radio down with it.
 *
 * Every reader downstream of the transport throws on malformed input, and that
 * is deliberate -- issue #2's whole point was that `u8` past the end returned
 * `undefined`, which flowed into position arithmetic and produced NaN tank
 * coordinates with no error anywhere. The fix made them raise instead.
 *
 * The throw then had nowhere to land. Traced the whole path before touching it:
 *
 *   BridgeTransport.receive       calls `onPacket` bare; only `send` is guarded
 *   MatchHost.handlePacket        `readInput(r)` with no try
 *   MatchClient.handlePacket      dispatches into applySnapshot/applyEvent, no try
 *   BleTransport.onFrame          called `onPacket` bare  <- the one gap
 *   LanHost, WiFi side            already guarded, and says why in a comment
 *
 * So the two transports faced the same hazard and only one of them survived it.
 * On BLE the message reached the native module's callback as an unhandled error
 * and the match ended for everyone.
 *
 * Reachable without malice, by this transport's own account of itself: "over
 * BLE a truncated packet is a routine input, not an exotic one -- a fragment
 * can be dropped, or a write cut short at a renegotiated MTU".
 *
 * The peer is kept, which is where this deliberately differs from LanHost --
 * see the comment at the call site. Asserted here so the difference is a
 * decision rather than an oversight.
 */
test('a packet the game handler cannot read is reported, not thrown at the radio', () => {
  const { adapter, connects, deliver } = controllableAdapter();
  const sent: PeerId[] = [];
  const transport = new BleTransport({ ...adapter, sendFrame: (to) => sent.push(to) });

  const errors: string[] = [];
  transport.setEvents({
    onPacket: () => {
      throw new Error('packet ends after 1 byte, 4 needed at offset 3');
    },
    onError: (err) => errors.push(err.message),
  });
  connects('phone');

  // One frame, so the framer hands it straight up rather than holding it.
  const framer = new BleFramer(18);
  const frames = framer.fragment(Uint8Array.from([1, 2, 3]));
  assert.equal(frames.length, 1, 'the fixture must be a single-fragment message');

  assert.doesNotThrow(
    () => deliver('phone', frames[0]),
    'the throw reached the adapter callback, which on a phone is the native module',
  );
  assert.deepEqual(
    errors,
    ['packet ends after 1 byte, 4 needed at offset 3'],
    'the failure has to be reported, not merely swallowed -- a silent catch is a radio that goes quiet',
  );

  // The peer stays. Bluetooth drops fragments as a matter of routine, so a
  // corrupt message is usually the link and not the sender; disconnecting for
  // one bad packet would drop players for ordinary noise. Observed by sending:
  // broadcast walks the peer map, so a frame reaching the platform addressed to
  // 'phone' is that peer still being in it.
  transport.broadcast(Uint8Array.from([9, 9]), true);
  assert.deepEqual(sent, ['phone'], 'one unreadable packet must not evict the player');

  // And the next packet still arrives, so this is a dropped message rather
  // than a dead pipe.
  const seen: number[] = [];
  transport.setEvents({ onPacket: (_from, data) => seen.push(data.length), onError: () => {} });
  deliver('phone', frames[0]);
  assert.deepEqual(seen, [3], 'the transport stopped delivering after catching once');
});
