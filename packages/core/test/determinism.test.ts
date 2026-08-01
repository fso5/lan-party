import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dsin, dcos, datan2, wrapAngle, Rng, PI } from '../src/math.js';
import { createWorld, step, isMatchOver } from '../src/sim.js';
import { loadArena, MISSIONS, VERSUS_MAPS } from '../src/maps/index.js';
import { emptyInput, type TankInput } from '../src/types.js';
import {
  Writer,
  Reader,
  writeInput,
  readInput,
  writeSnapshot,
  readSnapshot,
  writeShellSpawn,
  readShellSpawn,
  estimateDownstreamBps,
  MsgType,
} from '../src/net/protocol.js';

test('deterministic trig matches Math.* within tolerance', () => {
  // We do not need to equal Math.sin -- we need to be close enough that the
  // game feels right, and identical across engines. Check the first.
  let worstSin = 0;
  let worstAtan = 0;
  for (let i = -2000; i <= 2000; i++) {
    const a = (i / 2000) * PI * 2;
    worstSin = Math.max(worstSin, Math.abs(dsin(a) - Math.sin(a)));
    worstSin = Math.max(worstSin, Math.abs(dcos(a) - Math.cos(a)));
  }
  assert.ok(worstSin < 1e-9, `sin/cos error too large: ${worstSin}`);

  for (let i = 0; i < 500; i++) {
    for (let j = 0; j < 500; j += 7) {
      const y = (i - 250) / 50;
      const x = (j - 250) / 50;
      if (x === 0 && y === 0) continue;
      const d = Math.abs(wrapAngle(datan2(y, x) - Math.atan2(y, x)));
      worstAtan = Math.max(worstAtan, d);
    }
  }
  assert.ok(worstAtan < 1e-7, `atan2 error too large: ${worstAtan}`);
});

test('deterministic trig uses no unspecified Math functions', () => {
  // Guard against someone reintroducing Math.sin into the sim later. If any of
  // these are called during a full match run, cross-platform determinism is
  // silently broken and this catches it at the only time it is cheap to fix.
  const originals = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    atan: Math.atan,
    atan2: Math.atan2,
    pow: Math.pow,
  };
  const called: string[] = [];
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    (Math as unknown as Record<string, unknown>)[name] = (...args: number[]) => {
      called.push(name);
      return (originals[name] as (...a: number[]) => number)(...args);
    };
  }

  try {
    const w = createWorld({
      arena: loadArena(MISSIONS[4]),
      seed: 99,
      players: [{ team: 0, spawnIndex: 0 }],
    });
    const inputs = new Map<number, TankInput>();
    for (let t = 0; t < 600; t++) {
      inputs.set(0, { moveX: 0.6, moveY: 0.3, aimX: 1, aimY: 0.2, fire: t % 30 === 0, layMine: false });
      step(w, inputs);
    }
  } finally {
    for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
      (Math as unknown as Record<string, unknown>)[name] = originals[name];
    }
  }

  assert.deepEqual(called, [], `simulation called unspecified Math functions: ${[...new Set(called)].join(', ')}`);
});

test('Rng is reproducible from a seed and diverges between seeds', () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  const c = new Rng(1235);
  const seqA: number[] = [];
  const seqB: number[] = [];
  const seqC: number[] = [];
  for (let i = 0; i < 1000; i++) {
    seqA.push(a.next());
    seqB.push(b.next());
    seqC.push(c.next());
  }
  assert.deepEqual(seqA, seqB, 'same seed must give the same sequence');
  assert.notDeepEqual(seqA, seqC, 'different seeds must diverge');

  // Rough uniformity check -- a badly seeded xorshift can get stuck.
  const mean = seqA.reduce((s, v) => s + v, 0) / seqA.length;
  assert.ok(mean > 0.45 && mean < 0.55, `mean ${mean} is not uniform`);
});

test('identical inputs produce bit-identical worlds', () => {
  // This is the property the whole netcode rests on. Two worlds from the same
  // seed, fed the same inputs, must agree exactly after a long run -- including
  // AI decisions, mine scatter and destroyed terrain.
  const mk = () =>
    createWorld({
      arena: loadArena(MISSIONS[4]),
      seed: 20260801,
      players: [{ team: 0, spawnIndex: 0 }],
    });

  const w1 = mk();
  const w2 = mk();
  const scripted = new Rng(7);

  for (let t = 0; t < 3000; t++) {
    const input: TankInput = {
      moveX: scripted.range(-1, 1),
      moveY: scripted.range(-1, 1),
      aimX: scripted.range(-1, 1),
      aimY: scripted.range(-1, 1),
      fire: scripted.next() < 0.05,
      layMine: scripted.next() < 0.01,
    };
    step(w1, new Map([[0, { ...input }]]));
    step(w2, new Map([[0, { ...input }]]));
  }

  assert.equal(w1.tick, w2.tick);
  assert.deepEqual(
    w1.tanks.map((t) => [t.id, t.x, t.y, t.bodyAngle, t.turretAngle, t.alive]),
    w2.tanks.map((t) => [t.id, t.x, t.y, t.bodyAngle, t.turretAngle, t.alive]),
  );
  assert.deepEqual(
    w1.shells.map((s) => [s.x, s.y, s.vx, s.vy, s.bouncesLeft]),
    w2.shells.map((s) => [s.x, s.y, s.vx, s.vy, s.bouncesLeft]),
  );
  assert.deepEqual([...w1.arena.tiles], [...w2.arena.tiles], 'terrain damage must match');
  assert.deepEqual(w1.rng.save(), w2.rng.save(), 'RNG streams must stay in lockstep');
});

test('input packs to 8 bytes and survives a round trip', () => {
  const w = new Writer();
  writeInput(w, {
    tick: 1234,
    moveX: 0.5,
    moveY: -0.75,
    aimX: -1,
    aimY: 1,
    fire: true,
    layMine: false,
  });
  const buf = w.finish();
  assert.equal(buf.length, 8, 'input frame must stay tiny -- it is sent every tick');

  const r = new Reader(buf);
  assert.equal(r.u8(), MsgType.Input);
  const got = readInput(r);
  assert.equal(got.tick, 1234);
  assert.ok(Math.abs(got.moveX - 0.5) < 0.01);
  assert.ok(Math.abs(got.moveY + 0.75) < 0.01);
  assert.equal(got.fire, true);
  assert.equal(got.layMine, false);
});

test('snapshot round-trips within visual tolerance and fits one BLE write', () => {
  const tanks = Array.from({ length: 8 }, (_, i) => ({
    id: i,
    x: 3.14159 + i * 2.2,
    y: 7.5 - i * 0.6,
    bodyAngle: (i / 8) * PI * 2 - PI,
    turretAngle: -(i / 8) * PI * 2 + 0.4,
    alive: i % 3 !== 0,
  }));

  const w = new Writer();
  writeSnapshot(w, 4321, tanks);
  const buf = w.finish();

  // 180 bytes is the safe single-write payload on iOS BLE.
  assert.ok(buf.length <= 180, `snapshot of 8 tanks is ${buf.length} bytes, over BLE budget`);
  assert.equal(buf.length, 4 + 8 * 6);

  const r = new Reader(buf);
  assert.equal(r.u8(), MsgType.Snapshot);
  const got = readSnapshot(r);
  assert.equal(got.tick, 4321);
  assert.equal(got.tanks.length, 8);

  for (let i = 0; i < 8; i++) {
    const a = tanks[i];
    const b = got.tanks[i];
    assert.equal(b.id, a.id);
    assert.equal(b.alive, a.alive);
    // 1/128 of a tile: far below what a player can perceive.
    assert.ok(Math.abs(b.x - a.x) < 1 / 128, `x drift ${Math.abs(b.x - a.x)}`);
    assert.ok(Math.abs(b.y - a.y) < 1 / 128, `y drift ${Math.abs(b.y - a.y)}`);
    // Angles get a byte: 1.4 degrees.
    const da = Math.abs(wrapAngle(b.bodyAngle - a.bodyAngle));
    assert.ok(da < 0.025, `body angle drift ${da}`);
  }
});

test('shell spawn packs the whole trajectory into 10 bytes', () => {
  const w = new Writer();
  writeShellSpawn(w, {
    shellId: 200,
    ownerId: 3,
    x: 12.3456,
    y: 5.4321,
    angle: 2.1,
    bounces: 2,
    tick: 900,
  });
  const buf = w.finish();
  assert.equal(buf.length, 10);

  const r = new Reader(buf);
  assert.equal(r.u8(), MsgType.Event);
  r.u8(); // NetEvent.ShellSpawn
  const got = readShellSpawn(r);
  assert.equal(got.shellId, 200);
  assert.equal(got.ownerId, 3);
  assert.equal(got.bounces, 2);
  assert.equal(got.tick, 900);
  assert.ok(Math.abs(got.x - 12.3456) < 1 / 128);
  assert.ok(Math.abs(got.y - 5.4321) < 1 / 128);
  assert.ok(Math.abs(got.angle - 2.1) < 0.025);
});

test('downstream bandwidth fits the BLE budget at 8 players', () => {
  const bps = estimateDownstreamBps(8, 15);
  // Raw BLE gives us roughly 2-8 KB/s in practice once several links are up.
  assert.ok(bps < 2000, `estimated ${bps} B/s exceeds the conservative BLE budget`);
});

test('all shipped arenas are well formed', () => {
  for (const m of [...MISSIONS, ...VERSUS_MAPS]) {
    const rows = m.rows;
    const width = rows[0].length;
    for (const r of rows) {
      assert.equal(r.length, width, `map "${m.name}" has a ragged row: "${r}"`);
    }
    const arena = loadArena(m);
    assert.ok(arena.spawns.length > 0, `map "${m.name}" has no spawn points`);
    // Every spawn must be somewhere a tank can actually stand.
    for (const s of arena.spawns) {
      assert.ok(
        arena.canTankOccupy(s.x, s.y, 0.38),
        `map "${m.name}" spawn at (${s.x}, ${s.y}) is inside geometry`,
      );
    }
    for (const e of arena.enemies) {
      assert.ok(
        arena.canTankOccupy(e.x, e.y, 0.38),
        `map "${m.name}" enemy at (${e.x}, ${e.y}) is inside geometry`,
      );
    }
  }
});

test('versus maps have four usable spawns for team play', () => {
  for (const m of VERSUS_MAPS) {
    const arena = loadArena(m);
    assert.equal(arena.spawns.length, 4, `versus map "${m.name}" needs exactly 4 spawns`);
    const teams = new Set(arena.spawns.map((s) => s.team));
    assert.equal(teams.size, 4, `versus map "${m.name}" spawns must be on 4 distinct teams`);
  }
});

test('a headless match runs to completion without stalling', () => {
  // Player sits still and never fires; the AI should eventually kill it. This
  // is the smoke test that the AI actually aims, fires and lands shots.
  const w = createWorld({
    arena: loadArena(MISSIONS[0]),
    seed: 4,
    players: [{ team: 0, spawnIndex: 0 }],
  });
  const idle = new Map([[0, emptyInput()]]);

  let ticks = 0;
  while (!isMatchOver(w) && ticks < 60 * 90) {
    step(w, idle);
    ticks++;
  }

  assert.ok(isMatchOver(w), 'match did not resolve within 90 seconds');
  assert.equal(w.tanks[0].alive, false, 'a stationary player should be killed by the AI');
});
