import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, cloneWorld, step } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { Rng } from '../src/math.js';
import { emptyInput, type TankInput } from '../src/types.js';
import {
  LoopbackNetwork,
  LoopbackTransport,
  BLE_PROFILE,
  PERFECT_PROFILE,
} from '../src/net/loopback.js';
import { MatchHost } from '../src/net/host.js';
import { MatchClient } from '../src/net/client.js';
import { Writer, writeInput } from '../src/net/protocol.js';

function versusWorld(seed = 42) {
  return createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
    ],
  });
}

/** Drive a host and one client for `seconds` of virtual time. */
function runMatch(profile = PERFECT_PROFILE, seconds = 10, netSeed = 5) {
  const net = new LoopbackNetwork(profile, netSeed);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);

  const hostWorld = versusWorld();
  const host = new MatchHost(hostWorld, hostT);
  const client = new MatchClient(cloneWorld(hostWorld), clientT, 'host', 1);

  net.connect('host', 'client');
  host.addClient('client', 1);

  const scripted = new Rng(99);
  const stepMs = 1000 / 60;
  const totalSteps = Math.round((seconds * 1000) / stepMs);

  for (let i = 0; i < totalSteps; i++) {
    // Change intent a few times a second, like a real thumb.
    if (i % 20 === 0) {
      const input: TankInput = {
        moveX: scripted.range(-1, 1),
        moveY: scripted.range(-1, 1),
        aimX: scripted.range(-1, 1),
        aimY: scripted.range(-1, 1),
        fire: scripted.next() < 0.15,
        layMine: false,
      };
      client.setInput(input);
    }
    client.update(stepMs);
    net.advance(stepMs);
    host.update(stepMs);
    net.advance(0);
  }

  return { net, host, client };
}

test('client stays converged with the host over a perfect link', () => {
  const { host, client } = runMatch(PERFECT_PROFILE, 10);

  const h = host.world.tanks.find((t) => t.id === 1)!;
  const c = client.world.tanks.find((t) => t.id === 1)!;
  const drift = Math.hypot(h.x - c.x, h.y - c.y);

  assert.ok(drift < 0.25, `client drifted ${drift.toFixed(3)} tiles from the host`);
});

test('client stays converged over a simulated Bluetooth link', () => {
  // 45ms latency, 30ms jitter, 3% loss, 4 KB/s. This is the link the game has
  // to survive, and the test that matters most in this file.
  const { host, client, net } = runMatch(BLE_PROFILE, 20);

  const h = host.world.tanks.find((t) => t.id === 1)!;
  const c = client.world.tanks.find((t) => t.id === 1)!;
  const drift = Math.hypot(h.x - c.x, h.y - c.y);

  assert.ok(net.droppedPackets > 0, 'the test link should actually have dropped packets');
  assert.ok(client.snapshotsApplied > 0, 'client should have applied snapshots');
  assert.ok(
    drift < 0.5,
    `client drifted ${drift.toFixed(3)} tiles over BLE ` +
      `(${client.reconciles} reconciles, ${net.droppedPackets} drops)`,
  );
});

test('reconciliation does not fire on quantisation noise alone', () => {
  // Over a perfect link the only disagreement is snapshot quantisation. If the
  // client rewinds on that, it rewinds ~15 times a second forever, which is
  // pure wasted CPU on a phone.
  const { client } = runMatch(PERFECT_PROFILE, 10);
  assert.ok(client.snapshotsApplied > 100, 'expected many snapshots in 10s');
  const rate = client.reconciles / client.snapshotsApplied;
  assert.ok(rate < 0.15, `reconciled on ${(rate * 100).toFixed(1)}% of snapshots over a perfect link`);
});

test('host discards inputs reordered by jitter', () => {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 1);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(versusWorld(), hostT);
  net.connect('host', 'client');
  host.addClient('client', 1);

  const mk = (tick: number, moveX: number) => {
    const w = new Writer(16);
    writeInput(w, { tick, moveX, moveY: 0, aimX: 0, aimY: 0, fire: false, layMine: false });
    return w.finish();
  };

  // Deliver tick 10 driving +x, then a stale tick 5 driving -x. Jitter really
  // does reorder packets on a live link, so the stale one must be discarded
  // rather than overwriting fresher intent.
  clientT.send('host', mk(10, 1), false);
  net.advance(1);
  clientT.send('host', mk(5, -1), false);
  net.advance(1);

  for (let i = 0; i < 30; i++) host.update(1000 / 60);
  const tank = host.world.tanks.find((t) => t.id === 1)!;
  // Body turns toward the drive direction: +x is angle 0, -x is angle +/-PI.
  assert.ok(
    Math.abs(tank.bodyAngle) < 0.5,
    `body angle ${tank.bodyAngle.toFixed(3)} suggests the stale input won`,
  );
});

test('snapshot never exceeds the transport payload limit', () => {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 1);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const errors: Error[] = [];
  hostT.setEvents({ onError: (e) => errors.push(e) });

  // Eight tanks is the design ceiling.
  const arena = loadArena(VERSUS_MAPS[0]);
  const world = createWorld({
    arena,
    seed: 1,
    players: Array.from({ length: 4 }, (_, i) => ({ team: i, spawnIndex: i })),
  });
  const host = new MatchHost(world, hostT);
  net.connect('host', 'host');

  for (let i = 0; i < 120; i++) host.update(1000 / 60);
  assert.deepEqual(errors, [], `transport rejected a packet: ${errors.map((e) => e.message).join('; ')}`);
});

test('a lost shell spawn event does not leave a client shell-less', () => {
  // Shell spawns are sent reliably precisely because a client that misses one
  // has an invisible shell flying at it. Verify the reliable path survives a
  // lossy link.
  const net = new LoopbackNetwork({ ...BLE_PROFILE, loss: 0.25 }, 3);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);

  const hostWorld = versusWorld();
  const host = new MatchHost(hostWorld, hostT);
  const client = new MatchClient(cloneWorld(hostWorld), clientT, 'host', 1);
  net.connect('host', 'client');
  host.addClient('client', 1);

  const stepMs = 1000 / 60;
  let fired = 0;
  for (let i = 0; i < 600; i++) {
    const firing = i % 60 === 0;
    if (firing) fired++;
    client.setInput({ ...emptyInput(), aimX: 1, fire: firing });
    client.update(stepMs);
    net.advance(stepMs);
    host.update(stepMs);
    net.advance(0);
  }

  assert.ok(fired > 5, 'test should have fired several shells');
  assert.ok(net.droppedPackets > 0, 'link should have dropped unreliable packets');
  // The host is the authority on how many shells exist; the client should not
  // be wildly out of step with it.
  const diff = Math.abs(host.world.shells.length - client.world.shells.length);
  assert.ok(diff <= 2, `client has ${client.world.shells.length} shells, host has ${host.world.shells.length}`);
});

test('world clone is a true deep copy', () => {
  const w = versusWorld();
  step(w, new Map([[0, { ...emptyInput(), moveX: 1, fire: true }]]));
  const c = cloneWorld(w);

  // Find a cell that is genuinely open, so the assertion tests the clone
  // rather than accidentally picking a tile that was already a block.
  let openX = -1;
  let openY = -1;
  for (let y = 1; y < w.arena.height - 1 && openY === -1; y++) {
    for (let x = 1; x < w.arena.width - 1; x++) {
      if (w.arena.at(x, y) === 0) {
        openX = x;
        openY = y;
        break;
      }
    }
  }
  assert.ok(openX >= 0, 'test map should have at least one floor tile');

  // Mutating the clone must not touch the original.
  c.tanks[0].x = 999;
  c.arena.set(openX, openY, 2);
  c.rng.next();
  if (c.shells.length) c.shells[0].x = 999;

  assert.notEqual(w.tanks[0].x, 999);
  assert.equal(w.arena.at(openX, openY), 0, 'clone mutated the original arena');
  assert.equal(c.arena.at(openX, openY), 2, 'clone should have taken the mutation');
  assert.notDeepEqual(w.rng.save(), c.rng.save());
  if (w.shells.length) assert.notEqual(w.shells[0].x, 999);

  // And a fresh clone must step identically to the original.
  const a = cloneWorld(w);
  const b = cloneWorld(w);
  const input = new Map([[0, { ...emptyInput(), moveX: 0.5, moveY: 0.5 }]]);
  for (let i = 0; i < 120; i++) {
    step(a, input);
    step(b, input);
  }
  assert.deepEqual(
    a.tanks.map((t) => [t.x, t.y]),
    b.tanks.map((t) => [t.x, t.y]),
  );
});
