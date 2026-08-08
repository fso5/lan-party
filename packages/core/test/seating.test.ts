import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, freeSpawnIndex } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { TankKind } from '../src/types.js';
import { DEFAULT_MATCH_SIZE, TANK_RADIUS, TANK_SPECS, VERSUS_BOT_KINDS } from '../src/tuning.js';
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

/**
 * The versus fill must not contain a tank that cannot move.
 *
 * A property, not a spelling check. `moveSpeed: 0` is what makes Green and
 * Brown turrets, and a free-for-all points every other shooter at one -- so a
 * roster containing one is a seat that is over before the opening exchange
 * finishes. Reading `TANK_SPECS` rather than naming the forbidden kinds keeps
 * this true if a kind is ever retuned to or away from standing still.
 */
test('no versus bot fill uses a tank that cannot move', () => {
  assert.ok(VERSUS_BOT_KINDS.length > 0, 'the fill is empty, so it fills nothing');
  for (const kind of VERSUS_BOT_KINDS) {
    assert.ok(
      TANK_SPECS[kind].moveSpeed > 0,
      `the versus bot fill contains kind ${kind}, which has moveSpeed ` +
        `${TANK_SPECS[kind].moveSpeed} -- it cannot leave its spawn and is a free kill`,
    );
  }
});

/**
 * And it has to be able to fill a match without repeating itself immediately.
 *
 * Callers index it modulo its length, so a one-kind fill puts three of the same
 * tank in every game. `DEFAULT_MATCH_SIZE` is the size they fill to, minus the
 * one seat the human takes.
 */
test('the versus bot fill has enough variety for a full match', () => {
  assert.ok(
    new Set(VERSUS_BOT_KINDS).size >= DEFAULT_MATCH_SIZE - 1,
    `${new Set(VERSUS_BOT_KINDS).size} distinct kinds for ${DEFAULT_MATCH_SIZE - 1} bot seats`,
  );
});

/**
 * An impossible spawn index lands somewhere free rather than on somebody.
 *
 * `createWorld`'s last resort used to be `spawns[0]`, which is how two caller
 * bugs -- one in each host -- became invisible ones: the tank appeared on top
 * of whoever already had the first corner, and tanks do not collide, so nothing
 * pushed them apart.
 */
test('a spawn index the map does not have does not land on another tank', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  const world = createWorld({
    arena,
    seed: 1,
    players: [
      { team: 0, spawnIndex: 0 },
      /*
       * One past the end, on a team the map does not place -- which is exactly
       * the shape the WiFi bug produced, where the ninth browser was player 8
       * on team 8 of an eight-spawn map.
       *
       * The team matters. `createWorld` tries the team's own spawn before any
       * fallback, and these maps carry teams 0-7, so a bad index on team 1
       * quietly finds spawn 1 and never reaches the code this is testing. The
       * first version of this test did that and survived its mutation.
       */
      { team: 8, spawnIndex: arena.spawns.length },
    ],
  });

  const [a, b] = world.tanks;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(
    d >= TANK_RADIUS * 2,
    `both tanks are at ${a.x},${a.y} and ${b.x},${b.y} -- ${d.toFixed(2)} apart, so they share a square`,
  );
});

/**
 * And the fallback has to be deterministic, which is why it is a rule rather
 * than a throw.
 *
 * A client builds its world from the roster the host sent, running this same
 * function over the same list in the same order. If the two disagreed about
 * where a fallback tank stands, every snapshot afterwards would be correcting a
 * tank the client had put somewhere else -- the divergence would look like
 * netcode rather than like seating.
 */
test('the out-of-range fallback puts the tank in the same place every time', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  const roster = {
    seed: 5,
    players: [
      { team: 0, spawnIndex: 0 },
      // Teams past the map's own, so the free-spawn rule is what places these.
      { team: 8, spawnIndex: 99 },
      { team: 9, spawnIndex: 99 },
    ],
  };
  const one = createWorld({ arena, ...roster });
  const two = createWorld({ arena, ...roster });
  assert.deepEqual(
    one.tanks.map((t) => [t.x, t.y]),
    two.tanks.map((t) => [t.x, t.y]),
    'two builds of the same roster placed the tanks differently',
  );
  // And the two fallback tanks must not have been given the same free spawn.
  const [, b, c] = one.tanks;
  assert.ok(
    Math.hypot(b.x - c.x, b.y - c.y) >= TANK_RADIUS * 2,
    'two tanks with the same bad index were both sent to the same free spawn',
  );
});

/**
 * A roster carrying a tank kind this build does not know says so.
 *
 * `kind` is a `u8` off the wire and nothing between the socket and `makeTank`
 * narrows it. It used to surface as `TypeError: Cannot read properties of
 * undefined (reading 'reactionTicks')` from inside the AI setup -- a message
 * about none of the things that went wrong.
 *
 * The browser client reports any throw from this path as "version mismatch",
 * so an unnamed failure made a real bug and a real version mismatch read
 * identically. The assertion is on the *message* for that reason.
 */
test('a roster with an unknown tank kind is refused by name', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  assert.throws(
    () =>
      createWorld({
        arena,
        seed: 1,
        players: [{ team: 0, spawnIndex: 0 }],
        bots: [{ kind: 99, team: 1, spawnIndex: 1 }],
      }),
    /unknown tank kind 99/,
    'an unknown kind should name itself rather than fail somewhere downstream',
  );
});

/** And every kind the game actually ships still builds. */
test('every known tank kind can be seated', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  for (const kind of Object.keys(TANK_SPECS).map(Number)) {
    assert.doesNotThrow(
      () => createWorld({ arena, seed: 1, players: [], bots: [{ kind, team: 0, spawnIndex: 0 }] }),
      `kind ${kind} is in TANK_SPECS but cannot be seated`,
    );
  }
});
