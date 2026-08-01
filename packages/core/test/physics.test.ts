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
