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
 * ## Bots cost an order of magnitude more, and this used to hide it
 *
 * Every row above drives *player* tanks with scripted input. `step` only calls
 * `stepAi` for a tank carrying an `ai`, so none of those rows ran the shot
 * solver -- the single most expensive thing in the simulation -- and the
 * headline "the sim is 1% of a frame" described a match that cannot happen
 * outside this file. server.mjs fills a versus match with bots, and the whole
 * campaign is bots.
 *
 *     8 players    p99  ~130us   0.85%
 *     8 bots       p99  ~700us   4.34%
 *
 * Several times the cost, from a row that did not exist. Read the bot rows,
 * not the player ones, when asking whether a phone can hold 60Hz.
 *
 * The bot figure was 2095us when this row was added. Two changes since, both
 * driven by it: staggering when bots think so their solves stop landing on the
 * same tick, and abandoning traced paths already longer than the best one
 * found. Neither changes a decision the AI makes.
 *
 * A phone is slower than this box. At twenty times slower the player-only
 * figure still leaves the frame mostly free, but the bot figure does not --
 * so the margin is a factor of a few, not the three orders of magnitude the
 * player rows implied.
 *
 * The first version of this measured nothing and looked fine, which is the
 * reason it is worth keeping rather than re-deriving. See `revive` below.
 */
import { createWorld, step, loadArena, VERSUS_MAPS, emptyInput, TICK_HZ, MAX_LOBBY_SLOTS, TankKind } from '@tanks/core';

import { fileURLToPath } from 'node:url';
import { requireFreshCore } from './lib/fresh-core.mjs';

// These numbers describe packages/core/dist, not packages/core/src. See the
// note in lib/fresh-core.mjs -- an A/B run that skipped the rebuild once
// compared a change against itself and reported no difference.
requireFreshCore(fileURLToPath(new URL('..', import.meta.url)));

// The mobile kinds. Brown and Green never move, so a bench made of them would
// measure a cheaper AI than the game runs, and the stationary pair are not what
// server.mjs fills a match with anyway.
const BOT_KINDS = [TankKind.Grey, TankKind.Teal, TankKind.Yellow, TankKind.Black];
function run(label, players, busy, bots = 0) {
  const arena = loadArena(VERSUS_MAPS[0]);
  const world = createWorld({
    arena,
    seed: 7,
    players: Array.from({ length: players }, (_, i) => ({ team: i, spawnIndex: i })),
    // Bots cost what players do plus the shot solver, which is the whole point
    // of measuring them: `step` calls stepAi for any tank carrying an `ai`, and
    // ignores the scripted input for it entirely.
    bots: Array.from({ length: bots }, (_, i) => ({
      kind: BOT_KINDS[i % BOT_KINDS.length],
      team: players + i,
      spawnIndex: (players + i) % arena.spawns.length,
    })),
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
const allPlayers = run(`${MAX_LOBBY_SLOTS} players, all firing`, MAX_LOBBY_SLOTS, true);

console.log('');
run('4 players + 4 bots', 4, true, 4);
const allBots = run(`${MAX_LOBBY_SLOTS} bots`, 0, true, MAX_LOBBY_SLOTS);

console.log(`\np99 share of a frame: ${(allPlayers * 100).toFixed(2)}% all players, ` +
  `${(allBots * 100).toFixed(2)}% all bots`);
