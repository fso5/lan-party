import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, freeSpawnIndex } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { TankKind } from '../src/types.js';
import { DEFAULT_MATCH_SIZE, TANK_RADIUS } from '../src/tuning.js';
import type { Tank } from '../src/types.js';

/** Only the fields `freeSpawnIndex` reads. */
const at = (x: number, y: number, alive = true) => ({ x, y, alive }) as Tank;

test('an empty arena seats the first player at the first spawn', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  assert.equal(freeSpawnIndex(arena.spawns, []), 0);
});

test('a spawn with a living tank on it is skipped', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  const s = arena.spawns[0];
  assert.equal(freeSpawnIndex(arena.spawns, [at(s.x, s.y)]), 1);
});

test('a dead tank does not hold a spawn', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  const s = arena.spawns[0];
  assert.equal(freeSpawnIndex(arena.spawns, [at(s.x, s.y, false)]), 0);
});

test('a tank that has driven away frees the spawn it started on', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  const s = arena.spawns[0];
  assert.equal(freeSpawnIndex(arena.spawns, [at(s.x + 5, s.y + 5)]), 0);
});

/**
 * The margin is two radii, the distance at which two bodies touch.
 *
 * Worth pinning rather than left to the implementation: tanks do not collide
 * with each other, so a spawn judged free at a smaller distance still produces
 * two tanks sharing one square, which is invisible on screen and fatal to both
 * at the same moment. Just inside must be occupied, just outside must be free.
 */
test('occupied means close enough for two bodies to overlap', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  const s = arena.spawns[0];
  assert.equal(freeSpawnIndex(arena.spawns, [at(s.x + TANK_RADIUS * 2 - 0.01, s.y)]), 1, 'touching is occupied');
  assert.equal(freeSpawnIndex(arena.spawns, [at(s.x + TANK_RADIUS * 2 + 0.01, s.y)]), 0, 'clear is free');
});

test('a full arena reports no free spawn rather than an index', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  const tanks = arena.spawns.map((s) => at(s.x, s.y));
  assert.equal(freeSpawnIndex(arena.spawns, tanks), -1);
});

/**
 * The bug this exists for, on every versus map.
 *
 * A Bluetooth host seats itself at spawn 0 and fills the rest of a match-sized
 * lineup with bots. The seating code counted Player-kind tanks and used that
 * count as a spawn index -- so with one player and three bots it handed the
 * first joiner spawn 1, where a bot was already standing. The cap in front of
 * it compared the same player count against the spawn count and so never fired.
 *
 * Driven through `createWorld` rather than hand-placed tanks, so it fails if
 * the host's own bot lineup or the map's spawn list changes underneath it.
 */
test('a joiner is never seated on top of a bot the host placed', () => {
  for (const map of VERSUS_MAPS) {
    const arena = loadArena(map);
    const bots = [];
    for (let s = 1; s < Math.min(DEFAULT_MATCH_SIZE, arena.spawns.length); s++) {
      bots.push({ kind: TankKind.Grey, team: 90 + s, spawnIndex: s });
    }
    const world = createWorld({ arena, seed: 4242, players: [{ team: 0, spawnIndex: 0 }], bots });

    const idx = freeSpawnIndex(arena.spawns, world.tanks);
    assert.notEqual(idx, -1, `${map.name}: no free spawn for a joiner`);

    const spawn = arena.spawns[idx];
    for (const t of world.tanks) {
      const d = Math.hypot(t.x - spawn.x, t.y - spawn.y);
      assert.ok(
        d >= TANK_RADIUS * 2,
        `${map.name}: joiner sent to spawn ${idx} (${spawn.x},${spawn.y}) which is ` +
          `${d.toFixed(2)} from tank ${t.id} (kind ${t.kind}) -- they would share a square`,
      );
    }
  }
});
