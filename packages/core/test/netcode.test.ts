import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, cloneWorld, killTank, step } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { Rng } from '../src/math.js';
import { emptyInput, EventKind, TankKind, Tile, type TankInput } from '../src/types.js';
import {
  LoopbackNetwork,
  LoopbackTransport,
  BLE_PROFILE,
  PERFECT_PROFILE,
} from '../src/net/loopback.js';
import { MatchHost } from '../src/net/host.js';
import { MatchClient } from '../src/net/client.js';
import {
  MsgType,
  NetEvent,
  Writer,
  writeInput,
  writeMineSpawn,
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

/**
 * The host's own player fires or lays a mine once, on tick 5, and nobody moves.
 *
 * Deliberately the *host's* action rather than the client's: a client predicts
 * its own shots locally, so a test where the client shoots passes whether or
 * not spawn events work at all. The only thing that proves the wire is the
 * other direction.
 */
function hostActs(what: 'fire' | 'mine', profile = PERFECT_PROFILE, ticks = 90) {
  const net = new LoopbackNetwork(profile, 5);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);

  const hostWorld = versusWorld();
  const host = new MatchHost(hostWorld, hostT);
  host.localTankId = 0;
  const client = new MatchClient(cloneWorld(hostWorld), clientT, 'host', 1);

  net.connect('host', 'client');
  host.addClient('client', 1);

  const stepMs = 1000 / 60;
  let worstGap = 0;
  for (let i = 0; i < ticks; i++) {
    host.setLocalInput({
      ...emptyInput(),
      aimX: 0,
      aimY: 1,
      fire: what === 'fire' && i === 5,
      layMine: what === 'mine' && i === 5,
    });
    client.setInput(emptyInput());
    client.update(stepMs);
    net.advance(stepMs);
    host.update(stepMs);
    net.advance(0);

    // Give the spawn a generous window to cross the link before holding the
    // client to it -- BLE latency plus jitter is a few ticks.
    if (i < 15) continue;
    const mine = what === 'fire' ? host.world.shells : host.world.mines;
    const theirs = what === 'fire' ? client.world.shells : client.world.mines;
    const h = mine.find((e) => e.ownerId === 0);
    const c = theirs.find((e) => e.ownerId === 0);
    if (h && !c) worstGap = Infinity;
    else if (h && c) worstGap = Math.max(worstGap, Math.hypot(h.x - c.x, h.y - c.y));
  }

  return { host, client, worstGap };
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

/** Drive a host with hand-written input packets and count what tank 1 fires. */
function hostWithInputs() {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 1);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(versusWorld(), hostT);
  net.connect('host', 'client');
  host.addClient('client', 1);

  const fired = new Set<number>();
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) {
      host.update(1000 / 60);
      for (const s of host.world.shells) if (s.ownerId === 1) fired.add(s.id);
    }
  };
  const send = (t: number, fireSeq: number) => {
    const w = new Writer(16);
    writeInput(w, {
      tick: t, moveX: 0, moveY: 0, aimX: 0, aimY: 1, fire: false, layMine: false, fireSeq,
    });
    clientT.send('host', w.finish(), false);
    net.advance(1);
  };

  return { host, fired, tick, send };
}

test('a shot survives the input packet that carried it being dropped', () => {
  // Input is sent unreliably, and for the sticks that is right: a lost sample
  // is superseded by the next one 16ms later. A shot is not a continuous
  // quantity, so a lost one is simply gone -- while the client has already
  // drawn the shell. Measured on the Bluetooth profile before this: ten of
  // every 360 fire intents never arrived.
  //
  // Here the client fires twice and only the second packet gets through. The
  // count it carries is what makes the first shot recoverable.
  const { fired, tick, send } = hostWithInputs();

  send(1, 0); // the mark
  tick(5);
  send(10, 2); // two shots later; the packet saying "one" never arrived
  tick(60);

  assert.equal(fired.size, 2, 'both shots should have been fired, not just the one we heard about');
});

test('the host does not keep re-firing from an input it has already used', () => {
  // The other half, and the more damaging one: the host reuses a client's last
  // input every tick until a newer one arrives, so a `fire` bit left standing
  // in it produced a fresh shot every time the cooldown expired. Those shells
  // are real, they hit people, and the player who supposedly fired them never
  // saw them leave. In a minute of play the host fired 25 shots for a tank
  // whose own screen showed 18.
  const { fired, tick, send } = hostWithInputs();

  send(1, 0);
  tick(5);
  send(10, 1); // exactly one shot asked for
  tick(240); // four seconds of silence, twenty cooldowns' worth

  assert.equal(fired.size, 1, 'one shot was asked for, so one shot is what should exist');
});

test('a client that went quiet does not come back with a magazine to empty', () => {
  // A phone whose WiFi dropped for a few seconds reappears having fired
  // several times. Owing all of them would have its tank spray the room the
  // moment it reconnects, at a cadence nobody was ever holding the trigger
  // for. Two is enough to cover the one in flight and the one being asked for.
  const { fired, tick, send } = hostWithInputs();

  send(1, 0);
  tick(5);
  send(10, 5); // five shots' worth of silence
  tick(240);

  assert.ok(fired.size <= 2, `fired ${fired.size} shots at once on reconnect`);
  assert.ok(fired.size >= 1, 'but it should still fire');
});

test('the shot count still catches up when it wraps', () => {
  // Three bits on the wire, so it returns to zero every eight shots.
  const { fired, tick, send } = hostWithInputs();

  send(1, 7);
  tick(5);
  send(10, 0); // 7 -> 0 is one shot, not seven backwards
  tick(60);

  assert.equal(fired.size, 1, 'a wrap must read as one shot forward');
});

test('holding the trigger down does not buy extra shots on the host', () => {
  // The count has to be of shots the client's own simulation produced, not of
  // ticks the thumb was down. Counting intent looks identical while the
  // trigger is held -- both sides fire at their cooldown -- and comes apart
  // the moment it is released, with the host still owing shots nobody asked
  // for and firing them into an empty room.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 5);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(versusWorld(), hostT);
  host.localTankId = 0;
  const client = new MatchClient(cloneWorld(host.world), clientT, 'host', 1);
  net.connect('host', 'client');
  host.addClient('client', 1);

  const createdByClient = () => client.world.nextEntityId - startedAt;
  const startedAt = client.world.nextEntityId;
  const hostFired = new Set<number>();
  const stepMs = 1000 / 60;

  // Thirty ticks holding it down, then two seconds off the trigger.
  for (let i = 0; i < 150; i++) {
    client.setInput({ ...emptyInput(), aimX: 0, aimY: 1, fire: i < 30 });
    host.setLocalInput(emptyInput());
    client.update(stepMs);
    net.advance(stepMs);
    host.update(stepMs);
    net.advance(0);
    for (const s of host.world.shells) if (s.ownerId === 1) hostFired.add(s.id);
  }

  // The client only ever creates entities for its own tank -- see the spawn
  // authority passed to step() -- so its id counter is exactly what it fired.
  assert.ok(createdByClient() > 0, 'the client should have fired something');
  assert.equal(
    hostFired.size,
    createdByClient(),
    `host fired ${hostFired.size} for a tank whose own screen showed ${createdByClient()}`,
  );
});

test('a client never invents a shell for a tank it does not control', () => {
  // The host sends a spawn for every shell fired in the match, the bots'
  // included -- and the client is running those same bots in its own
  // simulation. Let it fire them and it holds two of each: the one it invented
  // and the one it was told about, different ids, slightly different places.
  // Measured before this was fixed: eleven more shells on the client than
  // existed on the host, in a minute of a bots-and-two-players match.
  //
  // No host and no input at all here, so anything created is invented.
  const arena = loadArena(VERSUS_MAPS[0]);
  const bots: { kind: number; team: number; spawnIndex: number }[] = [];
  for (let s = 2; s < arena.spawns.length; s++) {
    bots.push({ kind: TankKind.Grey, team: 90 + s, spawnIndex: s });
  }
  const world = createWorld({
    arena,
    seed: 42,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
    ],
    bots,
  });

  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(world, clientT, 'host', 1);
  clientT.setEvents({});

  const idsBefore = client.world.nextEntityId;
  for (let i = 0; i < 600; i++) client.update(1000 / 60);

  // Entity ids are only consumed by creating something, so the counter is the
  // honest count even for shells that have since expired -- which is what made
  // this hard to see from the world alone.
  assert.equal(
    client.world.nextEntityId,
    idsBefore,
    `the client created ${client.world.nextEntityId - idsBefore} entities with no host and no input`,
  );
  assert.equal(client.world.shells.length, 0, 'and no shells should be in flight');

  // The bots must still *move*, though -- that is what keeps them smooth
  // between snapshots, and a snapshot corrects it fifteen times a second.
  const bot = client.world.tanks.find((t) => t.id === 2)!;
  const start = world.arena.spawns[2];
  assert.ok(
    Math.hypot(bot.x - start.x, bot.y - start.y) > 0.5,
    'suppressing spawns must not also freeze the tanks',
  );
});

test('a reconciliation replay does not re-invent other tanks’ shells either', () => {
  // The restriction has to hold on the replay step as well as the live one. A
  // replay re-runs our stored inputs through the whole world, bots included,
  // so without it every reconciliation -- fifteen a second -- mints a fresh
  // batch of shells nobody else has.
  const arena = loadArena(VERSUS_MAPS[0]);
  const bots: { kind: number; team: number; spawnIndex: number }[] = [];
  for (let s = 2; s < arena.spawns.length; s++) {
    bots.push({ kind: TankKind.Grey, team: 90 + s, spawnIndex: s });
  }
  const build = () =>
    createWorld({
      arena,
      seed: 42,
      players: [
        { team: 0, spawnIndex: 0 },
        { team: 1, spawnIndex: 1 },
      ],
      bots,
    });

  const net = new LoopbackNetwork(BLE_PROFILE, 5);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);
  const host = new MatchHost(build(), hostT);
  host.localTankId = 0;
  const client = new MatchClient(cloneWorld(host.world), clientT, 'host', 1);
  net.connect('host', 'client');
  host.addClient('client', 1);

  const rng = new Rng(7);
  const stepMs = 1000 / 60;
  const hostEverHeld = new Set<string>();
  let strays = 0;

  for (let i = 0; i < 900; i++) {
    const thumb: TankInput = {
      moveX: rng.range(-1, 1),
      moveY: rng.range(-1, 1),
      aimX: rng.range(-1, 1),
      aimY: rng.range(-1, 1),
      fire: rng.next() < 0.2,
      layMine: false,
    };
    host.setLocalInput(thumb);
    client.setInput(thumb);
    client.update(stepMs);
    net.advance(stepMs);
    host.update(stepMs);
    net.advance(0);

    // Every shell the host has ever held. Compared against this rather than
    // against the host's *current* shells, because we run ten ticks ahead: one
    // the host has just destroyed legitimately outlives it on our side for a
    // few ticks, and that is timing, not invention. An invented shell carries
    // an id the host never issued for that tank at all.
    for (const h of host.world.shells) hostEverHeld.add(`${h.ownerId}:${h.id}`);

    // Our own tank is exempt: we predict those, and the two sides number them
    // independently.
    for (const s of client.world.shells) {
      if (s.ownerId === client.localTankId) continue;
      if (!hostEverHeld.has(`${s.ownerId}:${s.id}`)) strays++;
    }
  }

  assert.ok(client.reconciles > 20, `expected plenty of reconciles, got ${client.reconciles}`);
  assert.equal(strays, 0, `${strays} tick-samples held a shell the host never fired`);
});

test('a shell the other player fired stays on our screen', () => {
  // The whole netcode is in service of this. A spawn arrives several ticks
  // after the tick it describes, and the next snapshot rewinds past the moment
  // it landed -- so the client used to delete every shell it did not fire
  // itself, permanently, because the spawn is sent once and never repeated.
  // Under the Bluetooth profile that was every shell the opponent fired: still
  // lethal on the host, never drawn on the phone.
  const { host, client, worstGap } = hostActs('fire', BLE_PROFILE);

  const h = host.world.shells.find((s) => s.ownerId === 0);
  assert.ok(h, 'the host should still have its own shell in flight');
  assert.ok(
    client.world.shells.some((s) => s.ownerId === 0),
    "the host's shell is not on the client at all",
  );
  assert.ok(
    worstGap < 0.25,
    `the shell drifted ${worstGap === Infinity ? 'out of existence' : worstGap.toFixed(3) + ' tiles'} from the host's copy`,
  );
});

test('a mine the other player laid is on our screen too', () => {
  // Mines were never networked at all -- NetEvent.MineSpawn was declared and
  // nothing wrote it -- so the only mine a phone could see was its own, and an
  // opponent's killed you off an empty patch of floor.
  const { host, client } = hostActs('mine', BLE_PROFILE);

  const h = host.world.mines.find((m) => m.ownerId === 0);
  assert.ok(h, 'the host should still have its mine down');
  const c = client.world.mines.find((m) => m.ownerId === 0);
  assert.ok(c, "the host's mine is not on the client at all");

  // A mine never moves, so its position should survive the wire exactly to
  // quantisation, and both its timers are rebuilt rather than sent -- get the
  // arithmetic wrong and it arms or blows at a different moment on each phone.
  assert.ok(Math.hypot(h.x - c.x, h.y - c.y) < 0.02, 'mine position disagrees');
  assert.equal(c.armTick, h.armTick, 'mine arms at a different tick on the client');
  assert.equal(c.fuseTick, h.fuseTick, 'mine blows at a different tick on the client');
});

test('we do not end up with two copies of a mine we laid ourselves', () => {
  // The client predicts its own mine and the host confirms it. Matched on the
  // owner alone, the same as a shell, and tested with the ids deliberately
  // disagreeing -- which is the only thing that ever happens in a real match,
  // because the two sides number entities independently.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(cloneWorld(versusWorld(22)), clientT, 'host', 0);

  client.world.mines.push({
    id: 7, ownerId: 0, team: 0, x: 5, y: 5,
    fuseTick: client.world.tick + 300, armTick: client.world.tick + 45,
  });

  const w = new Writer(16);
  writeMineSpawn(w, { mineId: 51, ownerId: 0, x: 5, y: 5, tick: client.world.tick });
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  assert.equal(client.world.mines.filter((m) => m.ownerId === 0).length, 1, 'one mine, not two');
});

/** A client at tick 1000 with 40 ticks of history behind it, and no host. */
function clientWithHistory(localTankId = 0) {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const world = versusWorld(22);
  world.tick = 1000;
  const client = new MatchClient(cloneWorld(world), clientT, 'host', localTankId);
  clientT.setEvents({});
  for (let i = 0; i < 40; i++) client.update(1000 / 60);

  /** A snapshot that agrees with prediction exactly -- the routine case. */
  const agreeingSnapshot = (tick: number) => {
    const w = new Writer(64);
    writeSnapshot(
      w,
      tick,
      client.world.tanks.map((t) => ({
        id: t.id,
        alive: t.alive,
        x: t.x,
        y: t.y,
        bodyAngle: t.bodyAngle,
        turretAngle: t.turretAngle,
      })),
    );
    return w.finish();
  };

  return { client, agreeingSnapshot };
}

test('a block the host destroyed does not grow back', () => {
  // Terrain damage arrives as an event and appears in no snapshot, so a
  // reconciliation that restores a world recorded before the message is the
  // end of it: the block is back for good. Solid on your phone, gone on the
  // host -- your shells bounce off a wall the host will let them through, and
  // the two simulations disagree about the shape of the arena from then on.
  const { client, agreeingSnapshot } = clientWithHistory();

  const arena = client.world.arena;
  let bx = -1;
  let by = -1;
  outer: for (let y = 0; y < arena.height; y++) {
    for (let x = 0; x < arena.width; x++) {
      if (arena.at(x, y) === Tile.Block) {
        bx = x;
        by = y;
        break outer;
      }
    }
  }
  assert.ok(bx >= 0, 'the map should have a destructible block to shoot');

  const w = new Writer(8);
  w.u8(MsgType.Event).u8(NetEvent.BlockDestroyed).u16(by * arena.width + bx);
  client.handlePacket('host', w.finish());
  assert.equal(client.world.arena.at(bx, by), 0, 'the event should clear the block');

  client.handlePacket('host', agreeingSnapshot(1020));
  assert.equal(client.world.arena.at(bx, by), 0, 'the block grew back on the first reconcile');

  for (let i = 0; i < 60; i++) client.update(1000 / 60);
  client.handlePacket('host', agreeingSnapshot(client.world.tick - 5));
  assert.equal(client.world.arena.at(bx, by), 0, 'the block grew back later');
});

test('our own tank stays dead once the host says it died', () => {
  // Every other tank recovers from this on its own, because snapshots carry
  // `alive`. Ours does not: the overlay skips our tank whenever prediction
  // agrees with the host to within quantisation, and a dead tank has stopped
  // moving, so it agrees exactly. Stand still when you die -- which is what
  // being killed by a mine looks like -- and you go on driving a tank that
  // exists nowhere but on your own screen.
  const { client, agreeingSnapshot } = clientWithHistory(0);

  // The host is always behind our clock, so its kill tick lands in our history.
  const w = new Writer(8);
  w.u8(MsgType.Event).u8(NetEvent.TankKilled).u16(1030).u8(0).u8(1);
  client.handlePacket('host', w.finish());
  const alive = () => client.world.tanks.find((t) => t.id === 0)!.alive;
  assert.equal(alive(), false, 'the event should have killed us');

  // Rewinding to before the death: the replay passes through the death tick,
  // and the local sim has no reason to reproduce a kill it never simulated.
  client.handlePacket('host', agreeingSnapshot(1020));
  assert.equal(alive(), false, 'we came back alive reconciling from before the death');

  for (let i = 0; i < 60; i++) client.update(1000 / 60);
  client.handlePacket('host', agreeingSnapshot(client.world.tick - 5));
  assert.equal(alive(), false, 'we came back alive a second later');
});

test('our own tank stays dead when the correction lands after the death', () => {
  // The other half, and it needs its own test rather than a second assertion
  // in the one above: once a replay has passed through the death tick it
  // rewrites the stored worlds, so a rewind that reaches back past the death
  // *first* hides the case where one never does. Here the only snapshot is
  // from after it, so the replay never reaches the death tick at all and the
  // rewind base has to carry it already.
  const { client, agreeingSnapshot } = clientWithHistory(0);

  const w = new Writer(8);
  w.u8(MsgType.Event).u8(NetEvent.TankKilled).u16(1030).u8(0).u8(1);
  client.handlePacket('host', w.finish());
  const alive = () => client.world.tanks.find((t) => t.id === 0)!.alive;
  assert.equal(alive(), false, 'the event should have killed us');

  client.handlePacket('host', agreeingSnapshot(1035));
  assert.equal(alive(), false, 'we came back alive reconciling from after the death');
});

test('a resync does not leave a shell behind to be resurrected', () => {
  // A resync throws away history and restarts the clock, and it can restart it
  // *backwards* -- the case that produced it was a client that ran 900 ticks
  // past a sleeping host. The spawn log is keyed by tick, so anything still in
  // it can match a tick on the new timeline and put a long-dead shell back in
  // front of the player.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const world = versusWorld(22);
  world.tick = 1000;
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 0);
  clientT.setEvents({});

  for (let i = 0; i < 40; i++) client.update(1000 / 60);

  // Everyone alive, always -- so that if a tank ends up dead below, the only
  // thing that could have killed it is the log.
  const snapshotFor = (tick: number) => {
    const w = new Writer(64);
    writeSnapshot(
      w,
      tick,
      client.world.tanks.map((t) => ({
        id: t.id,
        alive: true,
        x: t.x,
        y: t.y,
        bodyAngle: t.bodyAngle,
        turretAngle: t.turretAngle,
      })),
    );
    return w.finish();
  };

  // The opponent fires, and we fold it in properly.
  const spawn = new Writer(16);
  writeShellSpawn(spawn, {
    shellId: 9, ownerId: 1, x: 12, y: 6, angle: 0, bounces: 1, tick: 1010,
  });
  client.handlePacket('host', spawn.finish());
  assert.equal(client.world.shells.length, 1, 'the spawn should have landed');

  // And it kills the other tank -- a death logged against tick 1012.
  const kill = new Writer(8);
  kill.u8(MsgType.Event).u8(NetEvent.TankKilled).u16(1012).u8(1).u8(0);
  client.handlePacket('host', kill.finish());
  assert.equal(client.world.tanks.find((t) => t.id === 1)!.alive, false);

  // Then we go deaf for long enough to force a resync back to tick 910.
  for (let i = 0; i < 30; i++) client.handlePacket('host', snapshotFor(900));
  assert.ok(client.resyncs > 0, 'the run should have forced a resync');
  assert.equal(client.world.shells.length, 0, 'a resync drops shells in flight');

  // Now live forward across tick 1010 again on the new timeline, and reconcile
  // across it. Nothing should come back.
  for (let i = 0; i < 120; i++) client.update(1000 / 60);
  client.handlePacket('host', snapshotFor(1000));

  assert.equal(client.world.shells.length, 0, 'a shell from the abandoned timeline came back');

  // The resync restored that tank from the snapshot, alive. A death left in
  // the log would kill it again the moment the new clock crossed tick 1012 --
  // a player struck down by a shell fired in a timeline nobody is in any more.
  assert.equal(
    client.world.tanks.find((t) => t.id === 1)!.alive,
    true,
    'a death from the abandoned timeline was applied again',
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

test('the host confirming our own shot does not become a second shell', () => {
  // The case the old dedupe could not handle, and the one that actually
  // happens: the ids disagree. The host allocates an id for every shell in the
  // match and we allocate only for the ones we predict, so within seconds of
  // play the two counters are nowhere near each other -- measured at 32 on the
  // host against 12 on the client. Matching on the id therefore failed every
  // time, and every shot we fired was drawn twice.
  const world = versusWorld(22);
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 0);

  // Our prediction, numbered by us.
  client.world.shells.push({
    id: 11, ownerId: 0, team: 0, x: 5, y: 5, vx: 1, vy: 0,
    radius: 0.12, bouncesLeft: 1, bornTick: client.world.tick, selfArmDelay: 8,
  });

  // The host's confirmation of that same shot, numbered by the host.
  const w = new Writer(16);
  writeShellSpawn(w, {
    shellId: 47, ownerId: 0, x: 5, y: 5, angle: 0, bounces: 1, tick: client.world.tick,
  });
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  assert.equal(
    client.world.shells.filter((s) => s.ownerId === 0).length,
    1,
    'one shell, not two -- the ids differ and always will',
  );
});

test('suppressing our own does not swallow somebody else’s', () => {
  // The guard is on the owner alone now, so it must not reach any further than
  // that. A dropped spawn is the expensive direction: that shell exists on the
  // host, kills you there, and is never drawn on your phone.
  const world = versusWorld(22);
  const net = new LoopbackNetwork(PERFECT_PROFILE, 3);
  const clientT = new LoopbackTransport('client', 'Client', net);
  new LoopbackTransport('host', 'Host', net);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 0);

  // We hold a shell of our own numbered 7 ...
  client.world.shells.push({
    id: 7, ownerId: 0, team: 0, x: 5, y: 5, vx: 1, vy: 0,
    radius: 0.12, bouncesLeft: 1, bornTick: client.world.tick, selfArmDelay: 8,
  });

  // ... and the opponent's shell arrives carrying the same byte.
  const w = new Writer(16);
  writeShellSpawn(w, {
    shellId: 7, ownerId: 1, x: 12, y: 6, angle: 0, bounces: 1, tick: client.world.tick,
  });
  clientT.setEvents({});
  client.handlePacket('host', w.finish());

  assert.equal(client.world.shells.filter((s) => s.ownerId === 1).length, 1, 'theirs must land');
  assert.equal(client.world.shells.filter((s) => s.ownerId === 0).length, 1, 'and ours is untouched');
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
