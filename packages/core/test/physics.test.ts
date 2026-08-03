import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Arena, parseArena } from '../src/map.js';
import { stepShell, moveTank, sweepCircleHit } from '../src/physics.js';
import { dcos, dsin, PI } from '../src/math.js';
import { Tile } from '../src/types.js';

function box(rows: string[]): Arena {
  return new Arena(parseArena('test', rows));
}

/** A plain 10x8 empty room. */
const ROOM = [
  '##########',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '#........#',
  '##########',
];

test('shell bounces off a vertical wall with equal and opposite angle', () => {
  const a = box(ROOM);
  // Fire right and slightly down from mid-room.
  const speed = 5;
  const angle = 0.3;
  let x = 5,
    y = 4;
  let vx = dcos(angle) * speed;
  let vy = dsin(angle) * speed;
  const vyBefore = vy;
  let bounces = 1;

  for (let i = 0; i < 200 && bounces === 1; i++) {
    const r = stepShell(a, x, y, vx, vy, 0.12, bounces, speed / 60, true);
    x = r.x;
    y = r.y;
    vx = r.vx;
    vy = r.vy;
    bounces = r.bouncesLeft;
  }

  assert.equal(bounces, 0, 'shell should have used its bounce');
  // Reflection off a vertical face negates x only.
  assert.ok(vx < 0, 'x velocity should reverse');
  assert.ok(Math.abs(vy - vyBefore) < 1e-9, 'y velocity must be unchanged');
});

test('shell bounces off a horizontal wall with equal and opposite angle', () => {
  const a = box(ROOM);
  const speed = 5;
  let x = 5,
    y = 4;
  let vx = dcos(-1.2) * speed;
  let vy = dsin(-1.2) * speed;
  const vxBefore = vx;
  let bounces = 1;

  for (let i = 0; i < 200 && bounces === 1; i++) {
    const r = stepShell(a, x, y, vx, vy, 0.12, bounces, speed / 60, true);
    x = r.x;
    y = r.y;
    vx = r.vx;
    vy = r.vy;
    bounces = r.bouncesLeft;
  }

  assert.equal(bounces, 0);
  assert.ok(vy > 0, 'y velocity should reverse');
  assert.ok(Math.abs(vx - vxBefore) < 1e-9, 'x velocity must be unchanged');
});

test('shell fired straight at a wall returns along its own path', () => {
  const a = box(ROOM);
  const speed = 5;
  const startY = 4;
  let x = 5,
    y = startY;
  let vx = speed,
    vy = 0;
  let bounces = 1;

  for (let i = 0; i < 300 && bounces === 1; i++) {
    const r = stepShell(a, x, y, vx, vy, 0.12, bounces, speed / 60, true);
    x = r.x;
    y = r.y;
    vx = r.vx;
    vy = r.vy;
    bounces = r.bouncesLeft;
  }
  assert.ok(vx < 0);
  assert.ok(Math.abs(y - startY) < 1e-9, 'a perpendicular shot must not drift');
});

test('shell never escapes the arena, at any angle', () => {
  // The failure this guards against is tunnelling: a fast shell stepping past
  // a one-tile wall in a single tick. With 64 angles and 2000 ticks each, any
  // escape shows up immediately.
  const speed = 9;
  for (let i = 0; i < 64; i++) {
    const a = box(ROOM);
    const angle = (i / 64) * 2 * PI;
    let x = 5,
      y = 4;
    let vx = dcos(angle) * speed;
    let vy = dsin(angle) * speed;
    let bounces = 999;

    for (let t = 0; t < 2000; t++) {
      const r = stepShell(a, x, y, vx, vy, 0.12, bounces, speed / 60, false);
      x = r.x;
      y = r.y;
      vx = r.vx;
      vy = r.vy;
      bounces = r.bouncesLeft;
      assert.ok(
        x > 0.5 && x < 9.5 && y > 0.5 && y < 7.5,
        `shell escaped at angle ${angle.toFixed(3)}, tick ${t}: (${x.toFixed(3)}, ${y.toFixed(3)})`,
      );
      if (r.dead) break;
    }
  }
});

test('shell destroys a destructible block and continues', () => {
  const a = box([
    '##########',
    '#........#',
    '#...%....#',
    '#........#',
    '##########',
  ]);
  assert.equal(a.at(4, 2), Tile.Block);

  let x = 1.5,
    y = 2.5;
  const speed = 5;
  let vx = speed,
    vy = 0;
  let destroyed = 0;
  for (let i = 0; i < 100; i++) {
    const r = stepShell(a, x, y, vx, vy, 0.12, 1, speed / 60, true);
    destroyed += r.destroyed.length;
    x = r.x;
    y = r.y;
    vx = r.vx;
    vy = r.vy;
    if (destroyed > 0) break;
  }
  assert.equal(destroyed, 1, 'should have destroyed exactly one block');
  assert.equal(a.at(4, 2), Tile.Floor);
  assert.ok(vx > 0, 'shell keeps travelling after breaking a block');
});

test('shell passes over a hole without bouncing', () => {
  const a = box([
    '##########',
    '#........#',
    '#..OOO...#',
    '#........#',
    '##########',
  ]);
  let x = 1.5,
    y = 2.5;
  const speed = 5;
  let vx = speed,
    vy = 0;
  let bounced = false;
  // Travels speed/60 per iteration, so reaching x > 7 from x = 1.5 needs ~66.
  for (let i = 0; i < 120; i++) {
    const r = stepShell(a, x, y, vx, vy, 0.12, 1, speed / 60, true);
    if (r.bounces.length) bounced = true;
    x = r.x;
    y = r.y;
    if (x > 7) break;
  }
  assert.equal(bounced, false, 'holes must not deflect shells');
  assert.ok(x > 7, 'shell should have crossed the hole');
});

test('tank cannot drive into a wall but slides along it', () => {
  const a = box(ROOM);
  // Push hard into the top wall while also moving right.
  const r = moveTank(a, 5, 1.4, 0.1, -0.5, 0.38);
  assert.ok(r.y >= 1.38 - 1e-6, 'must not penetrate the wall');
  assert.ok(r.x > 5, 'must still slide along it');
});

test('tank cannot enter a hole', () => {
  const a = box([
    '##########',
    '#........#',
    '#..OOO...#',
    '#........#',
    '##########',
  ]);
  const r = moveTank(a, 3.5, 1.5, 0, 0.5, 0.38);
  assert.ok(r.y < 1.7, 'tank should be stopped at the edge of the hole');
});

test('swept collision catches a shell that would pass through in one step', () => {
  // Shell travelling 2 units in one step, straight through a tank at the midpoint.
  const hit = sweepCircleHit(0, 0, 2, 0, 0.12, 1, 0, 0.38);
  assert.equal(hit, true);
  // And a near miss stays a miss.
  const miss = sweepCircleHit(0, 0, 2, 0, 0.12, 1, 1, 0.38);
  assert.equal(miss, false);
});

/**
 * Every versus arena must treat its spawns identically.
 *
 * Nothing enforced this. The three shipped maps happen to be perfectly
 * symmetric -- measured before writing the test: each spawn on Crossfire and
 * The Moat sees exactly two others down an open line, each spawn on Pillars
 * sees exactly one, and on all three the nearest other spawn is 11.0 tiles
 * away from wherever you start.
 *
 * That is a property worth keeping rather than re-deriving. Asymmetric spawns
 * are the classic mistake when adding an arena, and the cost lands entirely on
 * one player: whoever starts in the open dies first, every round, and reads it
 * as the game being unfair rather than the map. Nobody playing has any way to
 * see that coming.
 *
 * Missions are deliberately exempt. One player against scripted enemies is
 * asymmetric on purpose.
 */
test('every versus arena gives all four spawns the same start', async () => {
  const { loadArena, VERSUS_MAPS } = await import('../src/maps/index.js');

  for (const map of VERSUS_MAPS) {
    const a = loadArena(map);
    assert.ok(a.spawns.length >= 2, `${map.name} needs spawns to compare`);

    const sightlines = a.spawns.map((s) =>
      a.spawns.filter((t) => t !== s && a.hasShellLineOfSight(s.x, s.y, t.x, t.y)).length,
    );
    assert.equal(
      new Set(sightlines).size,
      1,
      `${map.name}: spawns are exposed unequally -- sightlines to other spawns are [${sightlines}]. ` +
        `Whoever starts in the open loses every round and cannot tell why.`,
    );

    // Distance to the nearest neighbour, rounded to a tenth of a tile. Being
    // closer to the fight than everyone else is the other way a start is
    // unfair, and it is invisible on the map.
    const nearest = a.spawns.map((s) =>
      Math.min(
        ...a.spawns.filter((t) => t !== s).map((t) => Math.round(Math.hypot(s.x - t.x, s.y - t.y) * 10) / 10),
      ),
    );
    assert.equal(
      new Set(nearest).size,
      1,
      `${map.name}: one spawn starts closer to the fight than the others -- nearest neighbours are [${nearest}]`,
    );
  }
});

/**
 * Every tank in a map must be able to reach every other one.
 *
 * A map where somebody is walled off from the fight is unplayable, and it is
 * invisible reading the rows: an arena is drawn as text, and a wall closing a
 * pocket looks the same as one that does not. The player it happens to drives
 * around alone until everyone else finishes without them.
 *
 * Reachability, not coverage. Three of the eight maps have open cells no tank
 * can stand in -- The Moat has eighteen, being the island inside its moat --
 * and that is deliberate: shells fly over holes, so an island a tank cannot
 * enter is a bank-shot feature rather than a mistake. Asserting every open cell
 * is reachable would forbid it.
 */
test('every start in every map can reach every other start', async () => {
  const { loadArena, MISSIONS, VERSUS_MAPS } = await import('../src/maps/index.js');
  const { TANK_RADIUS } = await import('../src/tuning.js');

  for (const map of [...MISSIONS, ...VERSUS_MAPS]) {
    const a = loadArena(map);
    const starts = [...a.spawns, ...a.enemies];
    assert.ok(starts.length >= 2, `${map.name} should have something to compare`);

    const key = (x: number, y: number) => Math.floor(y) * a.width + Math.floor(x);
    const seen = new Set<number>();
    const stack: [number, number][] = [[Math.floor(starts[0].x), Math.floor(starts[0].y)]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
      if (seen.has(key(x, y))) continue;
      // The centre of the cell, which is where a tank sits when it is there.
      if (!a.canTankOccupy(x + 0.5, y + 0.5, TANK_RADIUS)) continue;
      seen.add(key(x, y));
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    const stranded = starts.filter((s) => !seen.has(key(s.x, s.y)));
    assert.equal(
      stranded.length,
      0,
      `${map.name}: ${stranded.length} start(s) walled off from the rest ` +
        `(${stranded.map((s) => `${s.x},${s.y}`).join(' ')}). Whoever gets that one ` +
        `drives around alone while the others finish the round.`,
    );
  }
});
