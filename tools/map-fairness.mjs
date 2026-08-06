/**
 * What a versus map does to the people standing on it.
 *
 *     node tools/map-fairness.mjs
 *
 * The fairness properties are asserted in physics.test.ts, which is the right
 * place for them but a poor instrument: a map author gets a pass or an
 * assertion message, not the shape of the problem. This prints the numbers for
 * every seat count so a new map can be iterated against them.
 *
 * It decides nothing and asserts nothing. It exists because that test's own
 * comment says the current maps cannot seat 5-8 equally and that "a future map
 * can aim at it" -- and aiming needs a target you can see.
 *
 * ## What the columns mean
 *
 * **sightlines** — for each seat in play, how many other seats it can see down
 * an open line. Unequal numbers mean whoever starts in the open dies first,
 * every round, and reads it as the game being unfair rather than the map.
 *
 * **nearest** — distance in tiles to the closest other seat in play. Being
 * closer to the fight than everyone else is the other way a start is unfair,
 * and it is invisible looking at the rows.
 *
 * **symmetry** — mismatched tiles under each of the rectangle's moves. Zero
 * under any one of them is what makes the rest of this hold; it is the cause,
 * where the two columns above are the consequence.
 *
 * ## Why 5-8 come out unequal, which is not a bug to fix here
 *
 * Eight starts on a rectangle fall into two orbits under its symmetries --
 * corners and edge midpoints -- and those are different kinds of place. No
 * amount of nudging points makes a corner equivalent to an edge. A map that
 * seats eight equally has to be drawn for it: eight positions in a single
 * orbit, which on a rectangle means all eight on edges or a shape that is not
 * a rectangle.
 */
import { loadArena, VERSUS_MAPS, MAX_LOBBY_SLOTS } from '@tanks/core';

const round1 = (n) => Math.round(n * 10) / 10;

function seatStats(arena, n) {
  const inPlay = arena.spawns.slice(0, n);
  const sightlines = inPlay.map(
    (s) => inPlay.filter((t) => t !== s && arena.hasShellLineOfSight(s.x, s.y, t.x, t.y)).length,
  );
  const nearest = inPlay.map((s) =>
    round1(Math.min(...inPlay.filter((t) => t !== s).map((t) => Math.hypot(s.x - t.x, s.y - t.y)))),
  );
  return { sightlines, nearest, fair: new Set(sightlines).size === 1 && new Set(nearest).size === 1 };
}

function symmetry(arena) {
  const moves = {
    'rot180': (x, y) => [arena.width - 1 - x, arena.height - 1 - y],
    'mirror-x': (x, y) => [arena.width - 1 - x, y],
    'mirror-y': (x, y) => [x, arena.height - 1 - y],
  };
  const out = {};
  for (const [name, move] of Object.entries(moves)) {
    let bad = 0;
    for (let y = 0; y < arena.height; y++) {
      for (let x = 0; x < arena.width; x++) {
        const [mx, my] = move(x, y);
        if (arena.at(x, y) !== arena.at(mx, my)) bad++;
      }
    }
    out[name] = bad;
  }
  return out;
}

for (const m of VERSUS_MAPS) {
  const arena = loadArena(m);
  const sym = symmetry(arena);
  const exact = Object.entries(sym)
    .filter(([, n]) => n === 0)
    .map(([n]) => n);

  console.log(`\n${m.name}  ${arena.width}x${arena.height}, ${arena.spawns.length} seats`);
  console.log(
    `  symmetry: ${
      exact.length ? `exact under ${exact.join(', ')}` : 'NONE EXACT'
    }   (mismatched tiles: ${Object.entries(sym).map(([k, v]) => `${k} ${v}`).join(', ')})`,
  );

  for (let n = 2; n <= Math.min(MAX_LOBBY_SLOTS, arena.spawns.length); n++) {
    const { sightlines, nearest, fair } = seatStats(arena, n);
    console.log(
      `  ${String(n).padStart(2)} seats  ${fair ? 'fair   ' : 'UNEQUAL'}  ` +
        `sightlines [${sightlines.join(',')}]  nearest [${nearest.join(',')}]`,
    );
  }
}

console.log(`
Seats are taken in order, so N players use seats 1..N -- which is why a map can
be fair at 4 and unfair at 3. Corners and edge midpoints are different kinds of
place and no map on a rectangle makes them equivalent; see the note at the top
of this file before trying to fix 5-8 by moving points around.`);
