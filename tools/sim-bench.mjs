/**
 * What share of a frame does the simulation actually cost?
 *
 * The whole game rests on holding 60Hz on a phone, and nothing had ever
 * measured the sim's part of that. The budget is 16.67ms per frame and the sim
 * shares it with rendering and the radio.
 *
 *     node tools/sim-bench.mjs
 *
 * Measured here, on a CI-class runner, at the fullest the game gets -- eight
 * tanks, everyone driving and holding the trigger, ~39 shells and ~15 mines
 * live:
 *
 *     8 players, all firing    mean 16-46us   p99 125-280us   = 0.75-1.68%
 *
 * Two runs on the same box gave the range above, so treat the order of
 * magnitude as the result and not the digits.
 *
 * A phone is slower than this box, but not by the three orders of magnitude
 * that would matter: even twenty times slower leaves the sim at a third of the
 * frame with the rest free. If that ever stops being true, this says so.
 *
 * The first version of this measured nothing and looked fine, which is the
 * reason it is worth keeping rather than re-deriving. See `revive` below.
 */
import { createWorld, step, loadArena, VERSUS_MAPS, emptyInput, TICK_HZ, MAX_LOBBY_SLOTS } from '@tanks/core';

import { fileURLToPath } from 'node:url';
import { requireFreshCore } from './lib/fresh-core.mjs';

// These numbers describe packages/core/dist, not packages/core/src. See the
// note in lib/fresh-core.mjs -- an A/B run that skipped the rebuild once
// compared a change against itself and reported no difference.
requireFreshCore(fileURLToPath(new URL('..', import.meta.url)));
function run(label, players, busy) {
  const arena = loadArena(VERSUS_MAPS[0]);
  const world = createWorld({
    arena,
    seed: 7,
    players: Array.from({ length: players }, (_, i) => ({ team: i, spawnIndex: i })),
  });

  // Everyone driving, aiming and holding the trigger: the worst case the game
  // can actually reach, not an idle world.
  const inputs = new Map();
  const drive = (t) => ({
    ...emptyInput(),
    moveX: Math.sin(t / 17),
    moveY: Math.cos(t / 23),
    aimX: Math.cos(t / 13),
    aimY: Math.sin(t / 11),
    fire: busy,
    layMine: busy && t % 40 === 0,
  });

  /*
   * Keep everyone alive.
   *
   * The first version of this measured nothing at all: eight tanks in a
   * free-for-all with the trigger held wipe each other out by tick 200, so the
   * warm-up finished the match and every measured tick stepped an empty world.
   * It reported 8 players costing less than 2 idle ones, which is the tell.
   */
  const revive = () => { for (const t of world.tanks) t.alive = true; };

  for (let t = 0; t < 600; t++) {
    revive();
    for (const tank of world.tanks) inputs.set(tank.id, drive(t));
    step(world, inputs);
  }

  const TICKS = 6000; // 100 seconds of play
  const samples = [];
  let shells = 0;
  let mines = 0;
  for (let t = 0; t < TICKS; t++) {
    revive();
    shells += world.shells.length;
    mines += world.mines.length;
    for (const tank of world.tanks) inputs.set(tank.id, drive(t));
    const a = performance.now();
    step(world, inputs);
    samples.push(performance.now() - a);
  }

  samples.sort((x, y) => x - y);
  const at = (p) => samples[Math.floor(samples.length * p)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const budget = 1000 / TICK_HZ;
  console.log(
    `${label.padEnd(34)} mean ${(mean * 1000).toFixed(0).padStart(4)}us  ` +
      `p50 ${(at(0.5) * 1000).toFixed(0).padStart(4)}us  ` +
      `p99 ${(at(0.99) * 1000).toFixed(0).padStart(5)}us  ` +
      `worst ${(samples[samples.length - 1] * 1000).toFixed(0).padStart(5)}us  ` +
      `= ${((at(0.99) / budget) * 100).toFixed(2)}% of a frame at p99` +
      `   [avg ${(shells / TICKS).toFixed(0)} shells, ${(mines / TICKS).toFixed(0)} mines live]`,
  );
  return at(0.99) / budget;
}

console.log(`budget: ${(1000 / TICK_HZ).toFixed(2)}ms per tick at ${TICK_HZ}Hz\n`);
run('2 players, idle', 2, false);
run('2 players, all firing', 2, true);
run('4 players, all firing', 4, true);
const worst = run(`${MAX_LOBBY_SLOTS} players, all firing`, MAX_LOBBY_SLOTS, true);
console.log(`\nworst p99 share of a frame: ${(worst * 100).toFixed(2)}%`);
