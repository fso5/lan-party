import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dsin, dcos, datan2, wrapAngle, Rng, PI } from '../src/math.js';
import { createWorld, step, isMatchOver } from '../src/sim.js';
import { loadArena, missionById, MISSIONS, VERSUS_MAPS } from '../src/maps/index.js';
import { Arena, parseArena } from '../src/map.js';
import { Tile, emptyInput, type TankInput } from '../src/types.js';
import { TANK_RADIUS } from '../src/tuning.js';
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
  quantPos,
  dequantPos,
  MAX_QUANT_POS,
  MAX_LOBBY_SLOTS,
  MsgType,
} from '../src/net/protocol.js';

test('every shipped map has an id of its own, and answers to it', () => {
  /*
   * The map id is the whole of what MatchStart says about which arena to
   * build: `missionById(start.mapId)` on every client, against a host that
   * picked the map. `missionById` searches the campaign first and returns the
   * first match, so two maps sharing an id is not a duplicate-key error
   * anywhere -- it is every client quietly building a different arena from the
   * host. Walls where there are none, spawns somewhere else, and no message on
   * any screen. Nothing enforces uniqueness; the ids are hand-written.
   *
   * Asked as "does each map answer to its own id" rather than as a set-size
   * comparison, because that is the property the clients depend on and it
   * names the offender when it breaks.
   */
  const all = [...MISSIONS, ...VERSUS_MAPS];
  for (const m of all) {
    const found = missionById(m.id);
    assert.ok(found, `map "${m.name}" has id ${m.id} and missionById cannot find it`);
    assert.equal(
      found.name,
      m.name,
      `id ${m.id} belongs to "${m.name}" but resolves to "${found.name}" -- ` +
        `a client would build the wrong arena and nothing would report it`,
    );
  }

  // An id nobody uses has to come back empty rather than fall back to
  // something, which is what lets a client say so instead of guessing.
  assert.equal(missionById(9999), undefined);
});

test('a full lobby starts on a full set of distinct spawns', () => {
  /*
   * The bug this pins was silent and total. Versus maps carried four spawns,
   * the lobby seats MAX_LOBBY_SLOTS, and `createWorld` falls back to
   * `spawns[0]` for any seat past the end -- so players five through eight all
   * started on player one's tile. Measured before the fix: five tanks reading
   * 2.50,1.50, and still reading it sixty ticks later, because tanks do not
   * collide with each other so nothing pushed them apart. In free-for-all they
   * are all enemies of each other, sharing one tile.
   *
   * Asserted through `createWorld` rather than by counting `arena.spawns`,
   * because the count is not the property that matters -- the fallback is what
   * made a short list dangerous, and only seating a full lobby exercises it.
   */
  for (const m of VERSUS_MAPS) {
    const arena = loadArena(m);
    const players = Array.from({ length: MAX_LOBBY_SLOTS }, (_, i) => ({
      team: i,
      spawnIndex: i,
    }));
    const world = createWorld({ arena, players, seed: 1 });
    assert.equal(world.tanks.length, MAX_LOBBY_SLOTS);

    const seen = new Map<string, number>();
    world.tanks.forEach((t, i) => {
      const at = `${t.x},${t.y}`;
      const first = seen.get(at);
      assert.equal(
        first,
        undefined,
        `map "${m.name}": seats ${first} and ${i} both start at ${at}`,
      );
      seen.set(at, i);
    });

    // Distinct is not enough on its own -- two spawns a third of a tile apart
    // would pass that and still be a shared corner in practice.
    for (let i = 0; i < world.tanks.length; i++) {
      for (let j = i + 1; j < world.tanks.length; j++) {
        const d = Math.hypot(world.tanks[i].x - world.tanks[j].x, world.tanks[i].y - world.tanks[j].y);
        assert.ok(
          d > TANK_RADIUS * 4,
          `map "${m.name}": seats ${i} and ${j} start ${d.toFixed(2)} tiles apart`,
        );
      }
    }

    // And every one of them has to be somewhere a tank can be.
    for (const t of world.tanks) {
      assert.ok(
        !arena.blocksTankAt(Math.floor(t.x), Math.floor(t.y)),
        `map "${m.name}": a spawn sits inside something solid at ${t.x},${t.y}`,
      );
    }
  }
});

test('spawns are ordered by the digit that authored them, not by scan order', () => {
  // `createWorld` indexes the spawn array by seat, so this ordering is what
  // makes "seat 3" mean the tile marked 4. Parse order alone would hand seat 0
  // whichever start happened to appear first in the text.
  const arena = new Arena(
    parseArena('ordering', [
      '########',
      '#4....3#',
      '#......#',
      '#2....1#',
      '########',
    ]),
  );
  assert.deepEqual(
    arena.spawns.map((s) => s.team),
    [0, 1, 2, 3],
  );
  assert.deepEqual(arena.spawns[0], { x: 6.5, y: 3.5, angle: 0, team: 0 });
  assert.deepEqual(arena.spawns[3], { x: 1.5, y: 1.5, angle: 0, team: 3 });
});

test('every shipped arena fits inside the position field on the wire', () => {
  /*
   * The other session's second finding, from the authoring side.
   *
   * `quantPos` clamps now instead of wrapping, so an oversized arena no longer
   * teleports an edge tank to the origin -- but clamping is not correctness,
   * only a less violent failure. Everything past 32 tiles still arrives at 32,
   * so tanks in the far corner of a 40-tile map would pile onto the same spot
   * on every other phone while moving normally on the host's own screen. They
   * asked for an assert in the map loader; this is that check, over the maps
   * actually shipped, so a map added later is covered without anyone
   * remembering to come back here.
   *
   * Strictly inside, not merely equal: a coordinate landing exactly on the
   * limit cannot be told apart from one past it.
   */
  for (const m of [...MISSIONS, ...VERSUS_MAPS]) {
    const { width, height } = loadArena(m);
    for (const [axis, extent] of [
      ['width', width],
      ['height', height],
    ] as const) {
      assert.ok(
        quantPos(extent) < MAX_QUANT_POS,
        `map "${m.name}" is ${extent} tiles in ${axis}; the wire's 12-bit position ` +
          `field stops at ${MAX_QUANT_POS / 128} tiles, so anything beyond it clamps`,
      );
      // Stated as the symptom as well as the bound: the far edge has to come
      // back where it went in.
      assert.ok(
        Math.abs(dequantPos(quantPos(extent)) - extent) < 1 / 128,
        `map "${m.name}": ${axis} ${extent} does not survive the round trip`,
      );
    }
  }
});

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

test('every shipped arena is walled in', () => {
  /*
   * A content check, and only that -- see the sealBorder test below for the
   * code half. All eight shipped maps are drawn with solid edges already, so
   * this passes with or without the constructor's safety net. What it catches
   * is a future map authored with a gap in its border.
   *
   * "shell never escapes the arena, at any angle" in physics.test.ts sounds
   * like it covers this and does not: it builds its own `box(ROOM)` whose
   * walls are spelled out in its tile data, so it proves the bouncer does not
   * tunnel through a wall that is definitely there. Nothing checked that the
   * maps players actually load have one.
   *
   * The escape matters in both directions: a shell that leaves the grid is
   * gone, and a tank that leaves it is somewhere no shot can reach. So this
   * asks the two questions the simulation asks rather than reading tiles --
   * shells and tanks are blocked by different sets of them, and a border made
   * of something a tank may drive over would pass a plain wall check.
   */
  for (const m of [...MISSIONS, ...VERSUS_MAPS]) {
    const arena = loadArena(m);
    const { width: w, height: h } = arena;
    for (let x = 0; x < w; x++) {
      for (const y of [0, h - 1]) {
        assert.ok(arena.blocksShellAt(x, y), `map "${m.name}": shells pass through border (${x},${y})`);
        assert.ok(arena.blocksTankAt(x, y), `map "${m.name}": tanks pass through border (${x},${y})`);
      }
    }
    for (let y = 0; y < h; y++) {
      for (const x of [0, w - 1]) {
        assert.ok(arena.blocksShellAt(x, y), `map "${m.name}": shells pass through border (${x},${y})`);
        assert.ok(arena.blocksTankAt(x, y), `map "${m.name}": tanks pass through border (${x},${y})`);
      }
    }
  }
});

test('an arena authored with an open border gets sealed anyway', () => {
  /*
   * The other half, and the one that actually covers the constructor.
   *
   * Every shipped map is drawn with solid edges, which is why commenting out
   * `sealBorder()` survives the whole suite -- the net has nothing to catch
   * yet. That makes it exactly the kind of code that gets deleted as dead one
   * day and is missed the next time somebody sketches a map without drawing
   * the frame. So this hands it a floor with no walls at all.
   */
  const w = 6;
  const h = 5;
  const open = new Arena({
    name: 'open',
    width: w,
    height: h,
    tiles: new Array(w * h).fill(Tile.Floor),
    spawns: [{ x: 2.5, y: 2.5, angle: 0, team: 0 }],
    enemies: [],
  });

  for (let x = 0; x < w; x++) {
    assert.ok(open.blocksShellAt(x, 0), `top border open at ${x}`);
    assert.ok(open.blocksShellAt(x, h - 1), `bottom border open at ${x}`);
  }
  for (let y = 0; y < h; y++) {
    assert.ok(open.blocksShellAt(0, y), `left border open at ${y}`);
    assert.ok(open.blocksShellAt(w - 1, y), `right border open at ${y}`);
  }
  // And it sealed only the border: the inside is still the floor it was given.
  assert.equal(open.at(2, 2), Tile.Floor, 'sealing the border filled the interior too');
});

/*
 * Whether a seat is actually *playable* -- reachable from the rest of the arena
 * rather than sealed into a pocket -- is checked by "every start in every map
 * can reach every other start" in physics.test.ts. It covers missions as well
 * as versus maps, counts authored enemies as starts, and accounts for
 * TANK_RADIUS rather than just the tile.
 *
 * Noted here because it took a full pass to rediscover: it is filed under
 * "start", every test in this file says "spawn", and a grep for one does not
 * find the other.
 */
test('versus maps have a usable spawn for every seat the lobby offers', () => {
  // Was "exactly 4", which is what the maps carried and what made seats 5-8
  // stack on seat 1's tile. Pinned to the lobby's own capacity now, so the two
  // numbers cannot drift apart again: raising MAX_LOBBY_SLOTS without adding
  // spawns fails here rather than on a phone.
  for (const m of VERSUS_MAPS) {
    const arena = loadArena(m);
    assert.ok(
      arena.spawns.length >= MAX_LOBBY_SLOTS,
      `versus map "${m.name}" has ${arena.spawns.length} spawns for ${MAX_LOBBY_SLOTS} seats`,
    );
    const teams = new Set(arena.spawns.map((s) => s.team));
    assert.equal(teams.size, arena.spawns.length, `versus map "${m.name}" repeats a spawn team`);
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
