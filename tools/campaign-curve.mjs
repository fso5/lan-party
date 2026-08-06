/**
 * Does the campaign get harder as it goes?
 *
 *     node tools/campaign-curve.mjs
 *
 * Missions are ordered as a curve and nothing had ever checked one. It does not
 * hold: difficulty climbs to mission three and then falls, so the finale is an
 * easier fight than the middle of the campaign.
 *
 * ## Read this before trusting any stand-in
 *
 * The obvious way to measure this is to drop a Player-spec tank in and see how
 * it does. That measures nothing. `makeTank` attaches an AI only when
 * `kind !== TankKind.Player`, so a Player-kind tank added through `bots` never
 * moves and never fires -- it is a parked target. The first version of this
 * reported 0% on every mission including the tutorial, which is the tell: a
 * perfect-aim stand-in losing to three Browns is not a difficulty result, it is
 * a broken harness. Confirmed by printing the tank: `ai: undefined`, 0 shells,
 * 0.00 tiles moved.
 *
 * So the stand-in has to be an enemy kind, and two are used rather than one --
 * they are not players and each has its own quirks, so a conclusion is only
 * worth drawing where both agree.
 *
 * ## What they say
 *
 *   mission          Grey   Teal      lineup
 *   First Contact     63%   100%      Brown + Brown + Brown
 *   Cork Yard         13%    46%      Brown + Grey + Grey
 *   The Gallery        0%     8%      Green + Teal + Teal
 *   Chasm              0%    33%      Green + Grey + Yellow
 *   Last Stand         8%    38%      Black + Green + Grey
 *
 * Both agree the hardest mission is the third, and both put the finale easier
 * than it. The lineups explain why: The Gallery fields two Teals, and Teal
 * measures as the strongest tank bar Black (see tools/tank-balance.mjs), while
 * Last Stand pairs one Black with Green -- which cannot move and loses 86% of
 * its duels.
 *
 * Not fixed here. Which enemies stand in which mission is content, and the
 * numbers are the input to that decision rather than the decision.
 */
import {
  createWorld,
  step,
  createMatch,
  updateMatch,
  DEFAULT_RULES,
  loadArena,
  MISSIONS,
  TankKind,
  TICK_HZ,
} from '@tanks/core';

import { fileURLToPath } from 'node:url';
import { requireFreshCore } from './lib/fresh-core.mjs';

// These numbers describe packages/core/dist, not packages/core/src. See the
// note in lib/fresh-core.mjs -- an A/B run that skipped the rebuild once
// compared a change against itself and reported no difference.
requireFreshCore(fileURLToPath(new URL('..', import.meta.url)));

const YARDSTICKS = [
  ['Grey', TankKind.Grey],
  ['Teal', TankKind.Teal],
];
const SEEDS = 24;
const CAP = TICK_HZ * 150;
const KIND_NAMES = { 1: 'Brown', 2: 'Grey', 3: 'Teal', 4: 'Yellow', 5: 'Green', 6: 'Black' };

function play(mission, kind, seed) {
  const arena = loadArena(mission);
  const w = createWorld({
    arena,
    seed,
    players: [],
    bots: [{ kind, team: 0, spawnIndex: 0 }],
  });
  const match = createMatch(DEFAULT_RULES, [0, 1]);
  for (let t = 0; t < CAP; t++) {
    step(w, new Map());
    if (updateMatch(match, w)) return { won: match.lastRoundWinner === 0, ticks: t };
  }
  return { won: false, ticks: CAP };
}

const results = new Map();
for (const [, kind] of YARDSTICKS) {
  for (const m of MISSIONS) {
    let won = 0;
    const times = [];
    for (let s = 0; s < SEEDS; s++) {
      const r = play(m, kind, 400 + s * 19);
      if (r.won) {
        won++;
        times.push(r.ticks / TICK_HZ);
      }
    }
    times.sort((a, b) => a - b);
    results.set(`${kind}:${m.name}`, {
      rate: Math.round((won / SEEDS) * 100),
      median: times.length ? times[Math.floor(times.length / 2)] : null,
    });
  }
}

console.log('win rate of an AI stand-in, over ' + SEEDS + ' seeds each');
console.log('(a Player-kind tank gets no AI at all -- see the note at the top)\n');
process.stdout.write('mission          ' + YARDSTICKS.map(([n]) => n.padStart(6)).join('') + '      lineup\n');
for (const m of MISSIONS) {
  const arena = loadArena(m);
  const lineup = arena.enemies
    .map((e) => KIND_NAMES[e.kind])
    .sort()
    .join(' + ');
  const cells = YARDSTICKS.map(([, k]) => `${String(results.get(`${k}:${m.name}`).rate).padStart(5)}%`).join('');
  process.stdout.write(`${m.name.padEnd(16)} ${cells}      ${lineup}\n`);
}

// State the ordering rather than leaving it to be eyeballed: the whole question
// is whether it rises, and a table does not answer that on its own.
for (const [name, kind] of YARDSTICKS) {
  const rates = MISSIONS.map((m) => results.get(`${kind}:${m.name}`).rate);
  const worst = Math.min(...rates);
  // Report every mission tied at the minimum. Taking indexOf would name one
  // arbitrarily -- with the Grey stand-in two missions both sit at 0%, and
  // picking the earlier of them would read as a sharper result than it is.
  const hardest = rates.map((r, i) => (r === worst ? i : -1)).filter((i) => i >= 0);
  const names = hardest.map((i) => `${MISSIONS[i].name} (${i + 1})`).join(', ');
  const finaleIncluded = hardest.includes(MISSIONS.length - 1);
  console.log(
    `\n${name}: hardest at ${worst}% -- ${names}` +
      (finaleIncluded
        ? hardest.length === 1
          ? ' -- the finale, as intended'
          : ' -- the finale ties for hardest'
        : ' -- not the finale'),
  );
}
