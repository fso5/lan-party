import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, cloneWorld, killTank, step } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { Rng } from '../src/math.js';
import { emptyInput, EventKind, type TankInput } from '../src/types.js';
import {
  LoopbackNetwork,
  LoopbackTransport,
  BLE_PROFILE,
  PERFECT_PROFILE,
} from '../src/net/loopback.js';
import { MatchHost } from '../src/net/host.js';
import { MatchClient } from '../src/net/client.js';
import {
  Writer,
  writeInput,
  writeRoundOver,
  writeShellSpawn,
  writeSnapshot,
} from '../src/net/protocol.js';

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
function runMatch(profile = PERFECT_PROFILE, seconds = 10, netSeed = 5, startTick = 0) {
  const net = new LoopbackNetwork(profile, netSeed);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);

  const hostWorld = versusWorld();
  hostWorld.tick = startTick;
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

test('client stays converged across the 16-bit tick wraparound', () => {
  // Ticks travel as 16 bits, so the wire value returns to zero every 65536
  // ticks -- 18 minutes at 60Hz, which is roughly one good session. Every
  // snapshot and every shell spawn carries one, and the client has to rebuild
  // the full tick from it. Get that wrong and the match falls apart at the
  // 18-minute mark and nowhere else, which is the hardest kind of bug to be
  // told about second-hand.
  const start = 0x10000 - 300;
  const { host, client } = runMatch(BLE_PROFILE, 10, 5, start);

  assert.ok(
    host.world.tick > 0x10000,
    `run must actually cross the boundary (ended at tick ${host.world.tick})`,
  );

  const h = host.world.tanks.find((t) => t.id === 1)!;
  const c = client.world.tanks.find((t) => t.id === 1)!;
  const drift = Math.hypot(h.x - c.x, h.y - c.y);

  assert.ok(client.snapshotsApplied > 100, 'expected many snapshots across the wrap');
  assert.equal(client.snapshotsStale, 0, 'no snapshot should land outside our window');
  assert.equal(client.resyncs, 0, 'a correct expansion needs no resync to recover');
  assert.ok(drift < 0.5, `client drifted ${drift.toFixed(3)} tiles across the wrap`);

  // Shells are simulated locally from a spawn event whose bornTick is also 16
  // bits. A mis-expanded bornTick makes a shell expire on arrival or never at
  // all, so compare the counts rather than trusting the tank positions alone.
  assert.equal(
    client.world.shells.length,
    host.world.shells.length,
    'shell counts diverged across the wrap',
  );
});

test('a snapshot from just before the wrap still lands in our history', () => {
  // The sharp version of the test above. Our clock has crossed the boundary
  // and the host's snapshot has not, so the wire tick reads near 65535 while
  // ours reads near 65540. Expanding against our own high bits alone puts the
  // snapshot 65536 ticks in the future, where nothing can rewind to it.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const world = versusWorld(22);
  world.tick = 0x10000 - 20;
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 0);

  // Step across the boundary so the ring holds ticks on both sides of it.
  for (let i = 0; i < 40; i++) client.update(1000 / 60);
  assert.ok(client.world.tick > 0x10000, 'client should have crossed the boundary');

  const at = 0x10000 - 5;
  const w = new Writer(64);
  writeSnapshot(
    w,
    at,
    client.world.tanks.map((t) => ({
      id: t.id,
      alive: t.alive,
      x: t.x,
      y: t.y,
      bodyAngle: t.bodyAngle,
      turretAngle: t.turretAngle,
    })),
  );
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  assert.equal(client.snapshotsStale, 0, `snapshot for tick ${at} was rejected as unreachable`);
  assert.equal(client.snapshotsApplied, 1, 'the snapshot should have been applied');
});

test('a shell fired just before the wrap is not dated to the far future', () => {
  // A spawn carries the tick it was fired on, and the client dates the shell
  // by it. Expand that wrong across the boundary and the shell's self-arm
  // delay never elapses: it flies forever unable to kill the tank that fired
  // it, which is a permanently wrong shell rather than one dropped frame.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(cloneWorld(versusWorld(22)), clientT, 'host', 0);
  client.world.tick = 0x10000 + 5;

  const firedAt = 0x10000 - 5;
  const w = new Writer(16);
  writeShellSpawn(w, { shellId: 3, ownerId: 1, x: 12, y: 6, angle: 0, bounces: 1, tick: firedAt });
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  const shell = client.world.shells.find((s) => s.ownerId === 1);
  assert.ok(shell, 'the spawn should have produced a shell');
  assert.equal(shell.bornTick, firedAt, `shell dated ${shell.bornTick}, fired at ${firedAt}`);
});

test('a shell fired just after the wrap is not dated to the distant past', () => {
  // The mirror case. We normally cross the boundary first, running ten ticks
  // ahead of the host -- but a stalled frame puts us behind it, and then the
  // host wraps while we have not. A spawn reading 5 is then ten ticks in our
  // future, not sixty-five thousand in our past. Date it to the past and the
  // shell is older than SHELL_MAX_LIFETIME_TICKS the instant it arrives, so it
  // is culled on the next step: it exists on the host, kills you there, and is
  // never drawn on your phone.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(cloneWorld(versusWorld(22)), clientT, 'host', 0);
  client.world.tick = 0x10000 - 5;

  const firedAt = 0x10000 + 5;
  const w = new Writer(16);
  writeShellSpawn(w, { shellId: 4, ownerId: 1, x: 12, y: 6, angle: 0, bounces: 1, tick: firedAt });
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  const shell = client.world.shells.find((s) => s.ownerId === 1);
  assert.ok(shell, 'the spawn should have produced a shell');
  assert.equal(shell.bornTick, firedAt, `shell dated ${shell.bornTick}, fired at ${firedAt}`);

  client.update(1000 / 60);
  assert.ok(
    client.world.shells.some((s) => s.ownerId === 1),
    'the shell was culled as expired on the very first step',
  );
});

test('the tick a round resumes on survives the wrap', () => {
  // resumeAtTick is a tick, so it is 16 bits on the wire like every other. It
  // has no consumer today -- the browser banner runs off a wall clock -- but a
  // countdown drawn from the raw wire value would read "already elapsed" for
  // every round after the first eighteen minutes, and that trap is much
  // cheaper to disarm here than to diagnose from a phone.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(cloneWorld(versusWorld(22)), clientT, 'host', 0);
  client.world.tick = 0x10000 - 6;

  const resumeAt = 0x10000 + 114;
  const w = new Writer(32);
  writeRoundOver(w, {
    winner: 0,
    resumeAtTick: resumeAt,
    scores: [{ team: 0, score: 1 }],
    matchOver: false,
  });
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  assert.equal(client.lastRound?.resumeAtTick, resumeAt);
  assert.ok(
    (client.lastRound?.resumeAtTick ?? 0) > client.world.tick,
    'the next round must still be in the future',
  );
});

test('host accepts an input whose tick has wrapped past its predecessor', () => {
  // The stale-input guard compares wire ticks. Tick 5 arriving after tick
  // 65530 is eleven ticks *newer*, not sixty-five thousand older -- and a
  // naive comparison would reject every input for the next 18 minutes,
  // freezing the player where they stood.
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

  clientT.send('host', mk(0x10000 - 6, -1), false);
  net.advance(1);
  clientT.send('host', mk(5, 1), false);
  net.advance(1);

  for (let i = 0; i < 30; i++) host.update(1000 / 60);
  const tank = host.world.tanks.find((t) => t.id === 1)!;
  assert.ok(
    Math.abs(tank.bodyAngle) < 0.5,
    `body angle ${tank.bodyAngle.toFixed(3)} suggests the post-wrap input was discarded as stale`,
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

test('a client whose clock falls behind the host resyncs instead of drifting', () => {
  // This is the failure that only appeared with two real browsers connected:
  // a client starting at tick 0 while the host is already running can never
  // apply a snapshot, because every snapshot describes a tick it has not
  // simulated yet. Reconciliation silently never happens and the two diverge.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 11);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);

  const hostWorld = versusWorld();
  const host = new MatchHost(hostWorld, hostT);
  net.connect('host', 'client');
  host.addClient('client', 1);

  // Run the host well ahead before the client ever starts.
  const stepMs = 1000 / 60;
  for (let i = 0; i < 200; i++) {
    host.update(stepMs);
    net.advance(stepMs);
  }
  assert.ok(hostWorld.tick > 150, 'host should be well ahead');

  // Client starts from a stale world at tick 0 -- the bug condition.
  const stale = cloneWorld(hostWorld);
  stale.tick = 0;
  const client = new MatchClient(stale, clientT, 'host', 1);

  for (let i = 0; i < 400; i++) {
    client.update(stepMs);
    net.advance(stepMs);
    host.update(stepMs);
    net.advance(0);
  }

  assert.ok(client.resyncs > 0, 'client should have forced a resync');
  assert.ok(
    client.world.tick > hostWorld.tick,
    `client (${client.world.tick}) must end up ahead of the host (${hostWorld.tick})`,
  );
  assert.ok(client.snapshotsApplied > 0, 'client should be applying snapshots after resync');

  const h = hostWorld.tanks.find((t) => t.id === 1)!;
  const c = client.world.tanks.find((t) => t.id === 1)!;
  const drift = Math.hypot(h.x - c.x, h.y - c.y);
  assert.ok(drift < 0.5, `client still ${drift.toFixed(3)} tiles from host after resync`);
});

/**
 * A player who leaves must not hold the round open for ever.
 *
 * A round ends when one team is left standing, and an abandoned tank keeps its
 * team in that count while sitting motionless at its spawn. Left alone, the
 * players still there have to hunt down and shoot a statue to finish -- two of
 * them around a maze if a pair left, and if everyone remaining is on one team
 * the round cannot end at all.
 */
test('a departed player’s tank is retired, and the round can end', () => {
  const world = versusWorld(11);
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const hostT = new LoopbackTransport('host', 'Host', net);
  new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(world, hostT);
  net.connect('host', 'client');
  host.addClient('client', 1);
  host.localTankId = 0;

  const leaver = () => host.world.tanks.find((t) => t.id === 1)!;
  assert.ok(leaver().alive);

  host.removeClient('client');

  // Still there through the grace period: a phone that drops WiFi for a second
  // and reconnects must not come back to a wreck.
  for (let i = 0; i < 60 * 9; i++) host.update(1000 / 60);
  assert.ok(leaver().alive, 'nine seconds is a hiccup, not a departure');
  assert.equal(host.match.phase, 'playing');

  for (let i = 0; i < 60 * 2; i++) host.update(1000 / 60);
  assert.equal(leaver().alive, false, 'and after the grace period the tank goes');

  // Which is the point: with only one team left standing the round resolves.
  assert.notEqual(host.match.phase, 'playing');
  assert.equal(host.match.lastRoundWinner, 0, 'the player still there takes it');
});

test('a player who reconnects inside the grace period keeps their tank', () => {
  const world = versusWorld(12);
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const hostT = new LoopbackTransport('host', 'Host', net);
  new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(world, hostT);
  net.connect('host', 'client');
  host.addClient('client', 1);
  host.localTankId = 0;

  host.removeClient('client');
  for (let i = 0; i < 60 * 3; i++) host.update(1000 / 60);

  // The browser reconnects on its own and the embedder re-seats it. A new
  // connection means a new peer id, which is why the countdown is keyed on the
  // tank rather than on the peer.
  host.addClient('client-2', 1);
  for (let i = 0; i < 60 * 20; i++) host.update(1000 / 60);

  assert.ok(host.world.tanks.find((t) => t.id === 1)!.alive, 'came back to a live tank');
  assert.equal(host.match.phase, 'playing', 'and the round is still running');
});

test('retiring a tank is announced, not just applied', () => {
  /*
   * The client would work out that the tank is gone regardless -- snapshots
   * carry the alive flag -- so this is not about state agreement. It is about
   * the `TankDestroyed` event, which is what draws the explosion. Without it a
   * tank blinks out of existence and the round result arrives unexplained.
   *
   * An earlier version of this test asserted the client's `alive` flag and
   * passed even with the event suppressed, which made it worth nothing.
   */
  const world = versusWorld(13);
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(world, hostT);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 0);
  net.connect('host', 'client');
  host.addClient('client', 1);
  host.localTankId = 0;

  const announced: number[] = [];
  host.removeClient('client');
  for (let i = 0; i < 60 * 12; i++) {
    host.update(1000 / 60);
    for (const ev of host.world.events) {
      if (ev.kind === EventKind.TankDestroyed) announced.push(ev.a);
    }
    net.advance(1000 / 60);
    client.update(1000 / 60);
  }

  assert.deepEqual(announced, [1], 'the retirement is a death like any other');
  assert.equal(host.world.tanks.find((t) => t.id === 1)!.alive, false);
  assert.equal(client.world.tanks.find((t) => t.id === 1)!.alive, false);
});

test('a countdown does not survive into the next round', () => {
  /*
   * Tank ids are handed out by roster order, so the id a leaver had is handed
   * to somebody else next round. A countdown that outlived the world it was
   * started in would retire whoever inherited the id -- a player who had done
   * nothing but join, killed ten seconds in, for a reason nothing on screen
   * could explain.
   */
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const hostT = new LoopbackTransport('host', 'Host', net);
  new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(versusWorld(14), hostT);
  host.roundBuilder = () => versusWorld(15);
  host.localTankId = 0;
  host.addClient('client', 1);

  host.removeClient('client');

  // End the round before the countdown expires: the host takes it, and the
  // next round is built with a fresh tank 1 that nobody has abandoned.
  killTank(host.world, host.world.tanks.find((t) => t.id === 1)!, 0);
  for (let i = 0; i < 60 * 20; i++) host.update(1000 / 60);

  assert.equal(host.match.round, 2, 'a second round started');
  assert.ok(
    host.world.tanks.find((t) => t.id === 1)!.alive,
    'the new occupant of tank 1 is not retired for the last player\u2019s departure',
  );
});

/**
 * A shell whose id happens to share its low byte with another live one must
 * still arrive.
 *
 * The client skips a spawn it thinks it already predicted, and it recognised
 * one by the eight bits of id the wire carries. Any other tank's shell landing
 * on the same low byte was therefore dropped -- and a dropped spawn is not a
 * cosmetic problem, because clients simulate shells locally: the shell exists
 * on the host, kills you there, and was never drawn on your phone.
 *
 * Measured before changing anything: forty full free-for-all rounds used at
 * most 53 entity ids each, and ids restart every round, so 256 is not reached
 * in normal play. This is not a bug anyone has hit. It is a severe consequence
 * behind a thin margin, and the dedupe was looser than it needed to be -- a
 * shell the client predicted is always one of its *own*, so the owner belongs
 * in the comparison. A genuine duplicate still matches; a stranger's shell no
 * longer does.
 */
test('a spawn is not dropped just because its low byte is taken', () => {
  const world = versusWorld(21);
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 0);

  // A live shell belonging to the local tank, id 7.
  client.world.shells.push({
    id: 7,
    ownerId: 0,
    team: 0,
    x: 5,
    y: 5,
    vx: 1,
    vy: 0,
    radius: 0.12,
    bouncesLeft: 1,
    bornTick: client.world.tick,
    selfArmDelay: 8,
  });

  // The opponent fires. Their shell is entity 263, which the wire carries as 7.
  const w = new Writer(16);
  writeShellSpawn(w, {
    shellId: 263 & 0xff,
    ownerId: 1,
    x: 12,
    y: 6,
    angle: 0,
    bounces: 1,
    tick: client.world.tick,
  });
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  const mine = client.world.shells.filter((s) => s.ownerId === 0);
  const theirs = client.world.shells.filter((s) => s.ownerId === 1);
  assert.equal(mine.length, 1, 'our own predicted shell is untouched');
  assert.equal(theirs.length, 1, 'and the opponent’s shell exists on our phone too');
});

test('our own predicted shell is still not added twice', () => {
  // The other half of the contract. Loosening the dedupe must not let the
  // host's copy of a shot we already predicted become a second shell -- a
  // phantom that only the shooter sees, travelling alongside the real one.
  const world = versusWorld(22);
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 0);

  client.world.shells.push({
    id: 7, ownerId: 0, team: 0, x: 5, y: 5, vx: 1, vy: 0,
    radius: 0.12, bouncesLeft: 1, bornTick: client.world.tick, selfArmDelay: 8,
  });

  const w = new Writer(16);
  writeShellSpawn(w, { shellId: 7, ownerId: 0, x: 5, y: 5, angle: 0, bounces: 1, tick: client.world.tick });
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  assert.equal(client.world.shells.filter((s) => s.ownerId === 0).length, 1, 'one shell, not two');
});

test('an opponent’s second shell arrives while their first is still flying', () => {
  // The other half again, from the id's side. A tank may have five shells in
  // the air at once, so matching on owner alone would drop every one after the
  // first -- invisible on your phone, lethal on the host's.
  const world = versusWorld(23);
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 0);
  clientT.setEvents({});

  for (const shellId of [11, 12]) {
    const w = new Writer(16);
    writeShellSpawn(w, {
      shellId,
      ownerId: 1,
      x: 12,
      y: 6,
      angle: 0,
      bounces: 1,
      tick: client.world.tick,
    });
    client.handlePacket('host', w.finish());
  }

  assert.equal(
    client.world.shells.filter((s) => s.ownerId === 1).length,
    2,
    'both of the opponent’s shells are on our phone',
  );
});

/**
 * The host's phone going to sleep is silent, and must not be.
 *
 * Nothing disconnects: the host's TCP threads keep the socket open while the
 * JS loop that steps the match stops. Snapshots simply cease. Every other
 * phone carries on predicting its own tank perfectly while every other tank
 * stands still -- which looks exactly like everyone else quitting at once.
 *
 * Measured before adding anything: fifteen seconds of that put the client 900
 * ticks past the host, and it snapped back on wake. The snap back is the
 * resync working. The silence in between is the part a player cannot
 * interpret, so the client now says how long it has been.
 */
test('a client can tell how long the host has been quiet', () => {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 5);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);
  const world = versusWorld(31);
  const host = new MatchHost(world, hostT);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 1);
  net.connect('host', 'client');
  host.addClient('client', 1);
  host.localTankId = 0;

  const step = 1000 / 60;
  for (let i = 0; i < 120; i++) {
    client.update(step);
    net.advance(step);
    host.update(step);
    net.advance(0);
  }
  assert.ok(
    client.msSinceHostUpdate < 500,
    `a healthy match should be hearing from the host constantly, got ${client.msSinceHostUpdate}ms`,
  );

  // The screen locks. The client keeps running; nothing else does.
  for (let i = 0; i < 60 * 5; i++) {
    client.update(step);
    net.advance(step);
  }
  assert.ok(
    client.msSinceHostUpdate > 4000,
    `five seconds of silence should be visible, got ${client.msSinceHostUpdate}ms`,
  );

  // And it wakes up.
  for (let i = 0; i < 60; i++) {
    client.update(step);
    net.advance(step);
    host.update(step);
    net.advance(0);
  }
  assert.ok(
    client.msSinceHostUpdate < 500,
    `the counter must reset once the host speaks again, got ${client.msSinceHostUpdate}ms`,
  );
});
