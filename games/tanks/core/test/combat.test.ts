/**
 * Shells against shells, and shells against mines.
 *
 * Both are rules of the original game this one clones: a shot can be answered
 * with a shot, and a mine can be set off from a distance by shooting it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, fireShell, layMine, step, type WorldState } from '../src/sim.js';
import { Arena, parseArena } from '../src/map.js';
import { EventKind, TankKind, type Shell } from '../src/types.js';
import { MINE_BLAST_RADIUS, MINE_FUSE_TICKS, MINE_RADIUS, TANK_RADIUS, TANK_SPECS, TICK_HZ } from '../src/tuning.js';

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
  shell(w, b.id, 9, 4.3, -5.5, 0); // 0.6 apart, beyond the 0.4 intercept reach
  run(w, TICK_HZ / 2);
  assert.equal(w.shells.length, 2, 'two shells that never touched destroyed each other');
});

test('shells that look like they touch do collide', () => {
  // 0.35 apart: the drawn shells overlap, though the bodies (0.24 together)
  // do not. This used to fly on, and it read as a miss that was a hit.
  const w = room();
  const [a, b] = w.tanks;
  shell(w, a.id, 4, 3.825, 5.5, 0);
  shell(w, b.id, 9, 4.175, -5.5, 0);
  run(w, TICK_HZ / 2);
  assert.equal(w.shells.length, 0, 'shells whose drawn bodies overlapped passed each other');
});

test('shells fired one after another do not destroy each other', () => {
  // 0.3 apart -- inside the intercept reach -- and drifting slowly apart, as
  // two shots do when the turret swings a little between them. At the
  // player's reload a stream of shots flies this close, and it must not eat
  // itself.
  const w = room();
  const [a] = w.tanks;
  shell(w, a.id, 3, 4, 5.1, 0);
  shell(w, a.id, 3.3, 4.05, 5.1, 0.3);
  run(w, TICK_HZ / 4);
  assert.equal(w.shells.length, 2, 'a stream of shells in the same direction destroyed itself');
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

// --- Matching the original game's tank roster ------------------------------

test("grey shells bounce once, like the player's; only green's bounce twice", () => {
  assert.equal(TANK_SPECS[TankKind.Grey].shell.maxBounces, 1);
  assert.equal(TANK_SPECS[TankKind.Player].shell.maxBounces, 1);
  assert.equal(TANK_SPECS[TankKind.Green].shell.maxBounces, 2);
  // And the green sniper's are fast -- as fast as a rocket.
  assert.equal(TANK_SPECS[TankKind.Green].shell.speed, TANK_SPECS[TankKind.Teal].shell.speed);
});

test('each tank type has its own limit on shells in flight', () => {
  const w = room();
  const [a] = w.tanks;
  const fireUntilRefused = (kind: TankKind) => {
    a.kind = kind;
    a.shellsOut = 0;
    w.shells.length = 0;
    let fired = 0;
    for (let i = 0; i < 20; i++) {
      a.nextFireTick = 0; // cooldowns are a separate rule; only the cap is under test
      if (fireShell(w, a)) fired++;
    }
    return fired;
  };
  assert.equal(fireUntilRefused(TankKind.Player), 5);
  assert.equal(fireUntilRefused(TankKind.Brown), 1);
  assert.equal(fireUntilRefused(TankKind.Grey), 1);
  assert.equal(fireUntilRefused(TankKind.Teal), 1);
  assert.equal(fireUntilRefused(TankKind.Yellow), 1);
  assert.equal(fireUntilRefused(TankKind.Green), 2);
  assert.equal(fireUntilRefused(TankKind.Black), 2);
});

test('the yellow tank lays four mines; the player two', () => {
  const w = room();
  const [a] = w.tanks;
  const layUntilRefused = (kind: TankKind) => {
    a.kind = kind;
    a.minesOut = 0;
    w.mines.length = 0;
    let laid = 0;
    for (let i = 0; i < 10; i++) {
      a.nextMineTick = 0;
      a.x = 2 + i; // spread out, so no blast question arises
      if (layMine(w, a)) laid++;
    }
    return laid;
  };
  assert.equal(layUntilRefused(TankKind.Player), 2);
  assert.equal(layUntilRefused(TankKind.Yellow), 4);
  assert.equal(layUntilRefused(TankKind.Black), 2);
  assert.equal(layUntilRefused(TankKind.Grey), 0);
});

test('a blast destroys shells caught in it', () => {
  const w = room();
  const [a, b] = w.tanks;
  w.mines.push({ id: 600, ownerId: b.id, team: b.team, x: 7, y: 4, fuseTick: w.tick + 1, armTick: w.tick + 1_000 });
  b.minesOut = 1;
  const inside = shell(w, a.id, 7.8, 4, 0, 0.01);
  const outside = shell(w, a.id, 7 + MINE_BLAST_RADIUS + 1, 4, 0, 0.01);
  run(w, 3);
  assert.ok(!w.shells.includes(inside), 'a shell inside the blast survived it');
  assert.ok(w.shells.includes(outside), 'a shell outside the blast was destroyed');
  assert.equal(a.shellsOut, 1, 'the destroyed shell was not given back to its owner');
});

test('a blast sets off the mines around it, and only those', () => {
  const w = room();
  const [a, b] = w.tanks;
  const mine = (id: number, x: number) =>
    w.mines.push({ id, ownerId: b.id, team: b.team, x, y: 4, fuseTick: w.tick + MINE_FUSE_TICKS, armTick: w.tick + 1_000 });
  // A row of mines each within reach of the last, then a gap, then one more.
  mine(700, 6);
  mine(701, 7.2);
  mine(702, 8.4);
  mine(703, 8.4 + MINE_BLAST_RADIUS + 1);
  b.minesOut = 4;

  shell(w, a.id, 3, 4, 5.5, 0);
  let blasts = 0;
  for (let i = 0; i < TICK_HZ; i++) {
    step(w, idle);
    blasts += w.events.filter((e) => e.kind === EventKind.MineExploded).length;
  }
  assert.equal(blasts, 3, 'the chain did not run exactly the length of the row');
  assert.deepEqual(w.mines.map((m) => m.id), [703], 'the mine out of reach went off, or a mine in reach did not');
  assert.equal(b.minesOut, 1);
});
