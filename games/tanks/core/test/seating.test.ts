import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, freeSpawnIndex } from '../src/sim.js';
import { loadArena, MISSIONS, VERSUS_MAPS } from '../src/maps/index.js';
import { parseArena } from '../src/map.js';
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

/*
 * A start digit written twice.
 *
 * Maps here are hand-drawn ASCII so a level reads as a picture in source, and
 * the cost of that is that '1' typed twice looks exactly like a level. Measured
 * before the guard existed: it parsed quietly into two spawn points both
 * carrying team 0.
 *
 * Two seats on one team is not a cosmetic duplicate. Every hostility decision
 * in the simulation keys off `team`, so it puts two people in a free-for-all
 * who cannot damage each other for the whole round -- the same symptom open
 * against the lobby as issue #9, which should not also be reachable by drawing
 * a map.
 */
test('a map that writes the same start twice is refused', () => {
  assert.throws(
    () => parseArena('dup', ['#####', '#1 1#', '#####']),
    /places start '1' 2 times/,
    'two spawns on one team parsed without complaint',
  );

  // The neighbouring cases still work, so the guard is not just refusing maps.
  const fine = parseArena('fine', ['#####', '#1 2#', '#####']);
  assert.equal(fine.spawns.length, 2);
  assert.deepEqual(
    fine.spawns.map((s) => s.team),
    [0, 1],
  );

  // Out-of-order digits are sorted, not rejected: '3' before '1' in the text
  // still hands seat 0 to the '1'.
  const ordered = parseArena('order', ['#####', '#3 1#', '#####']);
  assert.deepEqual(
    ordered.spawns.map((s) => s.team),
    [0, 2],
  );
  assert.equal(ordered.spawns[0].x, 3.5, 'seat 0 must be the tile holding the 1');
});

/*
 * A character that is not a map character.
 *
 * Same hazard as the duplicate start above, and the reason both exist: levels
 * are authored as pictures, so a wrong character still looks like a level.
 * Measured before the guard, both silent -- 'H' typed where '#' was meant left
 * a gap in the arena wall, and 'G' typed for 'g' deleted an enemy from a
 * mission outright.
 */
test('a map character that is not a map character is refused', () => {
  assert.throws(
    () => parseArena('typo', ['#####', 'H1.2#', '#####']),
    /has 'H' at column 0, row 1/,
    "a wall typo'd as 'H' parsed as floor, opening the arena",
  );

  assert.throws(
    () => parseArena('caps', ['#####', '#1G2#', '#####']),
    /has 'G' at column 2, row 1/,
    "an enemy typo'd as 'G' vanished instead of being placed",
  );

  // Both ways of writing floor stay legal, and '.' is the one the maps use.
  const dots = parseArena('dots', ['#####', '#1.2#', '#####']);
  assert.equal(dots.spawns.length, 2);
  const spaces = parseArena('spaces', ['#####', '#1 2#', '#####']);
  assert.equal(spaces.spawns.length, 2);

  // And every character the maps actually use is still accepted together.
  const all = parseArena('all', ['######', '#1%O.#', '#bgty#', '#nk..2', '######']);
  assert.equal(all.spawns.length, 2);
  assert.equal(all.enemies.length, 6, 'all six enemy letters must still place an enemy');
});

/*
 * A row shorter than its neighbours.
 *
 * Padded with floor, which is the right reading of a ragged string and the
 * wrong thing to accept quietly: two characters short turns the end of the
 * bottom wall into open floor and still parses.
 */
test('a map with ragged rows is refused', () => {
  assert.throws(
    () => parseArena('ragged', ['#####', '#1.2#', '###']),
    /rows of 3, 5 characters/,
    'a short row was padded with floor instead of being refused',
  );
});

/*
 * Every declared map parses, said once rather than relied on incidentally.
 *
 * The three guards above only protect anything if something loads every map,
 * and today something does: campaign.test.ts walks MISSIONS and the physics and
 * AI tests walk VERSUS_MAPS. That is a guarantee resting on a coincidence -- the
 * same shape as the package entry point, which was exercised only because the
 * browser smokes happened to import by name, and which got its own test for
 * exactly this reason.
 *
 * A map that stops being loaded stops being checked, and the failure is a
 * broken level shipping to a phone. So: assert it directly.
 */
test('every map the game offers parses', () => {
  const all = [...MISSIONS, ...VERSUS_MAPS];
  assert.ok(all.length >= 8, `only ${all.length} maps declared, so this is not walking the set`);

  for (const m of all) {
    const arena = loadArena(m);
    assert.ok(arena.width > 0 && arena.height > 0, `${m.name} parsed to ${arena.width}x${arena.height}`);
    // A versus map needs somewhere to put people; a campaign mission seats one
    // player and its enemies come from the letters.
    assert.ok(arena.spawns.length >= 1, `${m.name} has no start at all`);
  }

  // And the versus maps specifically carry a full lobby's worth, which is what
  // MAX_LOBBY_SLOTS promises anyone reading the roster.
  for (const m of VERSUS_MAPS) {
    assert.equal(
      loadArena(m).spawns.length,
      8,
      `${m.name} does not seat a full lobby, so the eighth player has nowhere to stand`,
    );
  }
});
