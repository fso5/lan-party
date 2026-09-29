/**
 * Shells against shells, and shells against mines.
 *
 * Both are rules of the original game this one clones: a shot can be answered
 * with a shot, and a mine can be set off from a distance by shooting it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, step, type WorldState } from '../src/sim.js';
import { Arena, parseArena } from '../src/map.js';
import { EventKind, type Shell } from '../src/types.js';
import { MINE_BLAST_RADIUS, MINE_FUSE_TICKS, MINE_RADIUS, TANK_RADIUS, TICK_HZ } from '../src/tuning.js';

/** An open room, tanks parked in opposite corners, well away from row 4. */
function room(): WorldState {
  const arena = new Arena(parseArena('open room', [
    '##############',
    '#1...........#',
    '#............#',
    '#............#',
    '#............#',
    '#............#',
    '#...........2#',
    '##############',
  ]));
  return createWorld({
    arena,
    seed: 3,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
    ],
  });
}

let nextId = 1000;
/** A shell in flight, owned by `owner`, counted against its limit. */
function shell(w: WorldState, owner: number, x: number, y: number, vx: number, vy: number): Shell {
  const s: Shell = {
    id: nextId++,
    ownerId: owner,
    team: w.tanks.find((t) => t.id === owner)!.team,
    x,
    y,
    vx,
    vy,
    radius: 0.12,
    bouncesLeft: 1,
    bornTick: w.tick,
    selfArmDelay: 8,
  };
  w.shells.push(s);
  w.tanks.find((t) => t.id === owner)!.shellsOut++;
  return s;
}

const idle = new Map();
const run = (w: WorldState, ticks: number) => {
  for (let i = 0; i < ticks; i++) step(w, idle);
};

test('two shells that meet destroy each other', () => {
  const w = room();
  const [a, b] = w.tanks;
  shell(w, a.id, 4, 4, 5.5, 0);
  shell(w, b.id, 9, 4, -5.5, 0);

  // 5 tiles apart, closing at 11 tiles/s: they meet in under half a second.
  run(w, TICK_HZ / 2);

  assert.equal(w.shells.length, 0, 'the shells passed through each other');
  assert.equal(a.shellsOut, 0, "the first owner never got its shot back");
  assert.equal(b.shellsOut, 0, "the second owner never got its shot back");
  assert.ok(a.alive && b.alive, 'a shell that was destroyed still killed a tank');
});

test('they meet where they meet, not at a wall', () => {
  // The shells must die in the middle of the room. Dying at the far walls
  // would also leave zero shells, for the wrong reason.
  const w = room();
  const [a, b] = w.tanks;
  shell(w, a.id, 4, 4, 5.5, 0);
  shell(w, b.id, 9, 4, -5.5, 0);
  let where: number | null = null;
  for (let i = 0; i < TICK_HZ && where === null; i++) {
    step(w, idle);
    const gone = w.events.find((e) => e.kind === EventKind.ShellExpired);
    if (gone) where = gone.x;
  }
  assert.ok(where !== null, 'no shell ever expired');
  assert.ok(Math.abs(where! - 6.5) < 0.5, `the shells died at x=${where}, not where they met (6.5)`);
});

test('shells too fast to overlap on any tick still collide', () => {
  // Each moves half a tile a tick toward the other, starting half a tile
  // apart: after one tick they have swapped places and are half a tile apart
  // again. Checking only where they end up would never see them touch.
  const w = room();
  const [a, b] = w.tanks;
  shell(w, a.id, 6.25, 4, 0.5 * TICK_HZ, 0);
  shell(w, b.id, 6.75, 4, -0.5 * TICK_HZ, 0);
  step(w, idle);
  assert.equal(w.shells.length, 0, 'fast shells tunnelled through each other');
});

test('shells that pass side by side leave each other alone', () => {
  const w = room();
  const [a, b] = w.tanks;
  shell(w, a.id, 4, 3.7, 5.5, 0);
  shell(w, b.id, 9, 4.3, -5.5, 0); // 0.6 apart, against a combined radius of 0.24
  run(w, TICK_HZ / 2);
  assert.equal(w.shells.length, 2, 'two shells that never touched destroyed each other');
});

test('a shell that also hits a tank that tick is not counted twice', () => {
  // A shell removed by a tank hit must not come back into the shell-on-shell
  // pass and hand its owner a second shot.
  const w = room();
  const [a, b] = w.tanks;
  shell(w, a.id, 4, 4, 5.5, 0);
  shell(w, b.id, 9, 4, -5.5, 0);
  run(w, TICK_HZ);
  assert.ok(a.shellsOut >= 0 && b.shellsOut >= 0);
  assert.equal(a.shellsOut + b.shellsOut, 0);
});

test('shooting a mine sets it off', () => {
  const w = room();
  const [a, b] = w.tanks;
  w.mines.push({ id: 500, ownerId: b.id, team: b.team, x: 8, y: 4, fuseTick: w.tick + MINE_FUSE_TICKS, armTick: w.tick + 1_000 });
  b.minesOut = 1;
  // Park the mine's owner inside the blast, to show the blast is real.
  b.x = 8 + MINE_BLAST_RADIUS - TANK_RADIUS;
  b.y = 4;

  shell(w, a.id, 4, 4, 5.5, 0);
  let exploded = false;
  for (let i = 0; i < TICK_HZ && !exploded; i++) {
    step(w, idle);
    exploded = w.events.some((e) => e.kind === EventKind.MineExploded);
  }

  assert.ok(exploded, 'the shell went through the mine without setting it off');
  assert.equal(w.mines.length, 0, 'the mine is still there');
  assert.equal(w.shells.length, 0, 'the shell survived hitting the mine');
  assert.equal(a.shellsOut, 0, 'the shooter never got its shot back');
  assert.equal(b.minesOut, 0, 'the layer never got its mine back');
  assert.ok(!b.alive, 'the blast from a shot mine hurt nobody');
});

test('a shell that misses a mine leaves it be', () => {
  const w = room();
  const [a, b] = w.tanks;
  w.mines.push({ id: 501, ownerId: b.id, team: b.team, x: 8, y: 4, fuseTick: w.tick + MINE_FUSE_TICKS, armTick: w.tick + 1_000 });
  // Passes just outside the mine's body.
  shell(w, a.id, 4, 4 + MINE_RADIUS + 0.12 + 0.05, 5.5, 0);
  run(w, TICK_HZ);
  assert.equal(w.mines.length, 1, 'a near miss set the mine off');
});
