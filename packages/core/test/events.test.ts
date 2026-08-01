/**
 * Transport event registration.
 *
 * Reported by the other session (issue #6) while wiring the lobby, and correct:
 * `setEvents(events: Partial<TransportEvents>)` is the standard signature for
 * *patch these handlers*, and it replaced wholesale. So the most ordinary line
 * a lobby can write --
 *
 *     transport.setEvents({ onPeerJoin: (p) => showPeer(p) });
 *
 * -- unhooked `MatchHost`'s `onPacket` and the host stopped receiving input from
 * every player, permanently, with no error thrown anywhere.
 *
 * That is the worst shape a bug can have on this project. The whole radio path
 * is asynchronous and failure-prone by nature, so "nothing is arriving" is the
 * symptom of a dozen ordinary conditions -- out of range, not advertising,
 * permissions refused. A silent API misuse hides inside that noise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { LoopbackNetwork, LoopbackTransport, PERFECT_PROFILE } from '../src/net/loopback.js';
import { MatchHost } from '../src/net/host.js';
import { Writer, writeInput } from '../src/net/protocol.js';

function twoPlayerWorld() {
  return createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 42,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
    ],
  });
}

function inputPacket(tick: number): Uint8Array {
  const w = new Writer(16);
  writeInput(w, { tick, moveX: 1, moveY: 0, aimX: 0, aimY: 1, fire: false, layMine: false });
  return w.finish();
}

/** Host + one connected client, wired exactly as an embedder would. */
function hostWithClient() {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 5);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(twoPlayerWorld(), hostT);
  net.connect('host', 'client');
  host.addClient('client', 1);
  return { net, hostT, clientT, host };
}

/**
 * The reported failure, pinned. This is the regression test the other session
 * asked for, and it fails against replace semantics.
 */
test('patching one handler leaves the others hooked up', () => {
  const { net, hostT, clientT, host } = hostWithClient();

  // What a lobby writes to show discovered phones. It names onPeerJoin and
  // nothing else, so nothing else may change.
  const seen: string[] = [];
  hostT.setEvents({ onPeerJoin: (peer) => seen.push(peer.id) });

  clientT.send('host', inputPacket(1), false);
  net.advance(50);

  // Under the old replace semantics the host's onPacket was gone and moveX
  // stayed 0 -- the tank simply never responded to its player again.
  host.update(1000 / 60);
  assert.equal(
    host.world.tanks[1].x !== twoPlayerWorld().tanks[1].x ||
      host.world.tanks[1].bodyAngle !== twoPlayerWorld().tanks[1].bodyAngle,
    true,
    'input must still reach the host after an unrelated handler is patched in',
  );

  // And the handler that was patched in has to actually work, or this test
  // would pass with a setEvents that ignored its argument entirely.
  hostT.setEvents({ onPeerJoin: (peer) => seen.push(peer.id) });
  const late = new LoopbackTransport('late', 'Late', net);
  net.connect('host', 'late');
  net.advance(10);
  assert.ok(seen.length > 0, 'the newly patched handler must be called');
  void late;
});

test('a handler is cleared only by naming it', () => {
  const { net, hostT, clientT, host } = hostWithClient();

  hostT.setEvents({ onPacket: undefined });
  clientT.send('host', inputPacket(1), false);
  net.advance(50);
  host.update(1000 / 60);

  // Explicit undefined is the documented way to unhook, so it must still work
  // -- merging must not become "handlers can only ever be added".
  assert.equal(host.world.tanks[1].x, twoPlayerWorld().tanks[1].x);
});

test('repeated patches accumulate rather than shadowing each other', () => {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 7);
  const a = new LoopbackTransport('a', 'A', net);
  const b = new LoopbackTransport('b', 'B', net);

  const calls: string[] = [];
  a.setEvents({ onPacket: () => calls.push('packet') });
  a.setEvents({ onPeerJoin: () => calls.push('join') });
  a.setEvents({ onError: () => calls.push('error') });

  net.connect('a', 'b');
  b.send('a', inputPacket(1), false);
  net.advance(50);

  assert.ok(calls.includes('packet'), 'the first handler registered must survive two more');
  assert.ok(calls.includes('join'));
});

/**
 * The other half of issue #6: an embedder that owns dispatch has to replace
 * `onPeerLeave`, which is what pruned the host's client map.
 */
test('a departed client can be unseated by an embedder that owns dispatch', () => {
  const { host } = hostWithClient();
  assert.ok(host.hasClient('client'));

  host.removeClient('client');
  assert.equal(host.hasClient('client'), false, 'a peer that left must not keep its seat');

  // Idempotent: a transport leave event can arrive after an explicit removal,
  // and the second one must not throw.
  host.removeClient('client');
  assert.equal(host.hasClient('client'), false);
});

test('a client that leaves stops being simulated and addressed', () => {
  const { net, hostT, clientT, host } = hostWithClient();

  // Drive the tank so it has non-zero intent, then pull the peer out.
  clientT.send('host', inputPacket(1), false);
  net.advance(50);
  host.update(1000 / 60);

  host.removeClient('client');
  const sent: number[] = [];
  hostT.setEvents({ onPacket: () => sent.push(1) });

  const before = { x: host.world.tanks[1].x, y: host.world.tanks[1].y };
  for (let i = 0; i < 60; i++) host.update(1000 / 60);

  // Without removal the slot survives and keeps feeding the tank its last
  // input until INPUT_STALE_TICKS, driving a phone that walked away.
  assert.equal(host.world.tanks[1].x, before.x, 'an unseated tank must not keep driving');
  assert.equal(host.world.tanks[1].y, before.y);
});
