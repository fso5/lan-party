/**
 * A floor under simulation cost, so an order-of-magnitude regression cannot
 * ship quietly.
 *
 * tools/sim-bench.mjs measures this properly and prints a table to read. It is
 * a tool, though: it runs when somebody remembers, and nothing in CI has ever
 * run it. So the two changes it drove -- staggering when bots think, and
 * abandoning traced paths already longer than the best found, together taking
 * the eight-bot p99 from 2095us to about 500us -- are currently protected by
 * nobody's memory.
 *
 * The whole game rests on holding 60Hz on a phone, the frame budget is 16.67ms,
 * and the simulation shares it with rendering and the radio. A change that made
 * `step` ten times more expensive would break the game on hardware nobody here
 * is testing on, and would break nothing in this test suite.
 *
 * ## Why bots, and why these bots
 *
 * `step` only runs the AI for a tank carrying an `ai`, and the shot solver is
 * the most expensive thing in the simulation. A bench of player tanks with
 * scripted input never touches it -- which is how sim-bench once reported "the
 * sim is 1% of a frame" about a match that cannot happen outside a test file.
 * Brown and Green never move, so they are left out: a roster of them measures a
 * cheaper AI than the game runs.
 *
 * ## The mean is the detector; the p99 is a backstop
 *
 * That split is measured, not a preference. Running the shot solver every tick
 * instead of once per reaction delay -- the regression this exists to catch --
 * moves the two very differently:
 *
 *                       healthy          solver every tick
 *     mean            57-90us            1239-1371us      ~18x
 *     p99            449-686us           1960-2190us       ~3x
 *
 * The p99 barely moves because it was already dominated by the ticks that do
 * the expensive work; what changes is how *many* ticks do it, and that lands
 * on the mean. So the mean bound is the tight one at 600us -- about seven times
 * the healthy figure, and half the regressed one, with room on both sides. The
 * p99 bound stays loose at 4000us: it is a backstop for something catastrophic,
 * and tightening it towards 1500us would buy little while flaking on a busy
 * runner.
 *
 * This is a wall clock on a shared machine, and a flaky performance test is
 * worse than none -- it teaches everyone to ignore a red run. The first draft
 * had the mean at 1500us, which caught the regression above at 1508us. Passing
 * by eight microseconds is not catching it; it is a coin toss that happened to
 * land well.
 *
 * The `worst` sample is deliberately not asserted on at all. Across runs it
 * ranged from 709us to 14776us on an idle box; it measures the garbage
 * collector, not this code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TICK_HZ } from '../src/tuning.js';
import { TankKind, emptyInput } from '../src/types.js';
import { createWorld, step } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';

/** The mobile kinds, matching tools/sim-bench.mjs so the numbers compare. */
const BOT_KINDS = [TankKind.Grey, TankKind.Teal, TankKind.Yellow, TankKind.Black];

const WARMUP_TICKS = 300;
const TICKS = 2000;

test('eight bots cost a small fraction of a frame', () => {
  const arena = loadArena(VERSUS_MAPS[0]);
  const world = createWorld({
    arena,
    seed: 7,
    players: [],
    bots: Array.from({ length: 8 }, (_, i) => ({
      kind: BOT_KINDS[i % BOT_KINDS.length],
      team: i,
      spawnIndex: i % arena.spawns.length,
    })),
  });

  const inputs = new Map<number, ReturnType<typeof emptyInput>>();
  // Driving, aiming and holding the trigger. A bot ignores this input -- `step`
  // runs its AI instead -- but a mine still gets laid, and the world stays as
  // busy as the game gets.
  const drive = (t: number) => ({
    ...emptyInput(),
    moveX: Math.sin(t / 17),
    moveY: Math.cos(t / 23),
    aimX: Math.cos(t / 13),
    aimY: Math.sin(t / 11),
    fire: true,
    layMine: t % 40 === 0,
  });

  /*
   * Keep everyone alive.
   *
   * Without this the measurement is worthless and looks fine: eight tanks in a
   * free-for-all with the trigger held wipe each other out inside a few hundred
   * ticks, and every tick after that steps an empty world very quickly. That
   * exact mistake is recorded in sim-bench's own comments -- it reported eight
   * players costing less than two idle ones. The assertions below exist so this
   * version cannot make it silently.
   */
  const revive = () => {
    for (const tank of world.tanks) tank.alive = true;
  };

  for (let t = 0; t < WARMUP_TICKS; t++) {
    revive();
    for (const tank of world.tanks) inputs.set(tank.id, drive(t));
    step(world, inputs);
  }

  const samples: number[] = [];
  let shells = 0;
  let fullyAliveTicks = 0;
  for (let t = 0; t < TICKS; t++) {
    revive();
    shells += world.shells.length;
    if (world.tanks.every((tank) => tank.alive)) fullyAliveTicks++;
    for (const tank of world.tanks) inputs.set(tank.id, drive(t));
    const started = performance.now();
    step(world, inputs);
    samples.push(performance.now() - started);
  }

  /*
   * What was actually measured, before what it cost.
   *
   * Each of these fails loudly in the case where the timings would look
   * wonderful for the wrong reason: an empty roster, a wiped-out world, or a
   * match with nothing flying in it.
   */
  assert.equal(world.tanks.length, 8, 'the roster is not eight tanks, so this is not the worst case');
  assert.equal(
    fullyAliveTicks,
    TICKS,
    `only ${fullyAliveTicks} of ${TICKS} ticks had all eight alive -- a thinning world is a cheap one`,
  );
  const shellsPerTick = shells / TICKS;
  assert.ok(
    shellsPerTick > 5,
    `only ${shellsPerTick.toFixed(1)} shells live per tick, so the collision work being timed is not the real load`,
  );

  samples.sort((a, b) => a - b);
  const p99us = samples[Math.floor(samples.length * 0.99)] * 1000;
  const meanUs = (samples.reduce((a, b) => a + b, 0) / samples.length) * 1000;
  const frameUs = (1000 / TICK_HZ) * 1000;

  // The sensitive one. See the header: this is what a solver running too often
  // actually moves.
  assert.ok(
    meanUs < 600,
    `mean tick cost ${meanUs.toFixed(0)}us (measured 57-90us healthy, 1239-1371us with the ` +
      `shot solver running every tick). A phone is several times slower than this box.`,
  );
  // The backstop, for something an order of magnitude worse than that.
  assert.ok(
    p99us < 4000,
    `p99 tick cost ${p99us.toFixed(0)}us, ${((p99us / frameUs) * 100).toFixed(1)}% of a 60Hz frame ` +
      `(measured 449-686us when this bound was set)`,
  );
});
