/**
 * Does the campaign get harder as it goes?
 *
 *     node tools/campaign-curve.mjs
 *
 * Missions are ordered as a curve and nothing had ever checked one. It did not
 * hold -- difficulty climbed steeply out of mission one and then wandered, with
 * the finale an easier fight than the middle -- and the lineups were retuned
 * until it did. It holds now, for both stand-ins. This tool is what says so, so
 * run it after touching a mission roster.
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
 * ## What they say, at 96 seeds
 *
 *   mission          Grey   Teal      lineup
 *   First Contact     82%    99%      Brown + Brown + Brown
 *   Cork Yard         23%    60%      Brown + Brown + Grey
 *   The Gallery       14%    50%      Green + Grey + Grey
 *   Chasm              8%    26%      Green + Grey + Yellow
 *   Last Stand         7%    21%      Black + Green + Grey
 *
 * ## Seeds: 24 screens, 96 decides
 *
 *     node tools/campaign-curve.mjs 24     # faster, for a quick look
 *
 * This used to default to 24, which is enough to see the shape and too few to
 * rank neighbouring missions. Grey reads 67% on First Contact over 24 seeds and
 * 82% over 96; the retune that produced the table above was proposed by a
 * 24-seed run that separated two missions by four wins against three, and only
 * became a result when 96 put real daylight between them. So the default is now
 * the number that decides, and the cheap run is the one you ask for. Do not
 * conclude anything from a gap of a few points at 24.
 *
 * ## How the ordering was reached, so it is not re-derived the hard way
 *
 * Reordering the missions cannot produce a climbing curve: the stand-ins do not
 * agree on which is hardest, so no single order is monotone for both, and
 * ordering by their average puts The Gallery last -- making a mission called
 * Last Stand the fourth of five.
 *
 * Hardening the finale cannot either, though that is where the eye goes. As
 * authored both stand-ins were already at the floor by mission three (Grey
 * [82 4 2 8 7], Teal [99 42 2 26 21]), so a monotone curve would have needed
 * missions three through five at 0% for both -- unwinnable rather than hard.
 * Six such substitutions were measured and none climbed. What worked was
 * softening the middle instead: one of Cork Yard's Greys became a Brown and The
 * Gallery's two Teals became Greys, which is where the headroom came from.
 *
 * (These numbers moved once for a reason that had nothing to do with lineups:
 * before the enemies stopped shooting each other, Cork Yard read 13%/46%
 * because the player was being handed 43% of that mission's kills by the enemy
 * team. Start any retune from a run of this tool, not from a table in a
 * comment.)
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
// 96 by default: see "Seeds" above. An argument overrides it for a quick look.
const SEEDS = Number(process.argv[2] ?? 96);
if (!Number.isInteger(SEEDS) || SEEDS < 1) {
  console.error(`usage: node tools/campaign-curve.mjs [seeds]   (got "${process.argv[2]}")`);
  process.exit(2);
}
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
