/**
 * Which tank actually beats which?
 *
 *     node tools/tank-balance.mjs
 *
 * types.ts describes an escalating enemy roster -- Brown "the tutorial enemy"
 * through Black the "late-game threat" -- and nothing had ever checked it. The
 * enum order is not load-bearing (maps author enemies by letter, and no code
 * ranks kinds), so what this measures is whether the *descriptions* are honest,
 * and whether a bot dropped into a versus match is a real opponent.
 *
 * Every pair duels on all three versus maps across twelve seeds with the sides
 * swapped, so a spawn advantage cannot read as a tank advantage. Sample run:
 *
 *   Brown    12.2%      Green    14.4%      Grey     53.9%
 *   Yellow   58.7%      Teal     77.8%      Black    82.6%
 *
 * Two things worth reading carefully rather than at face value.
 *
 * **A duel is not what Brown and Green are for.** Both are stationary, both sit
 * at the bottom, and that is close to a tautology: one on one, whoever cannot
 * dodge loses. Green is documented as punishing a player who stands still,
 * which is a property of playing against a person, not of a 1v1 against another
 * bot. So the low number is not evidence that Green is badly tuned -- it is
 * evidence that this measurement does not capture what Green is for.
 *
 * **Where it does bite is bot fill.** server.mjs tops a versus match up from
 * [Grey, Teal, Green], and a stationary turret among two roamers is a
 * conspicuously softer opponent than the others. That is a real difference a
 * player would feel, and it is a design call rather than a bug -- recorded
 * here, not changed.
 *
 * The mobile kinds do rank cleanly, and there the descriptions are off by one
 * pair: Teal beats Yellow 83% of the time while being described as the milder
 * of the two.
 */
import {
  createWorld,
  step,
  createMatch,
  updateMatch,
  DEFAULT_RULES,
  DRAW,
  loadArena,
  VERSUS_MAPS,
  TankKind,
  TICK_HZ,
} from '@tanks/core';

const KINDS = [
  ['Brown', TankKind.Brown],
  ['Grey', TankKind.Grey],
  ['Teal', TankKind.Teal],
  ['Yellow', TankKind.Yellow],
  ['Green', TankKind.Green],
  ['Black', TankKind.Black],
];

const SEEDS = 12;
const CAP = TICK_HZ * 150;

function duel(a, b, mapIdx, seed, swap) {
  const arena = loadArena(VERSUS_MAPS[mapIdx]);
  const w = createWorld({
    arena,
    seed,
    players: [],
    bots: [
      { kind: swap ? b : a, team: 0, spawnIndex: 0 },
      { kind: swap ? a : b, team: 1, spawnIndex: 1 },
    ],
  });
  const match = createMatch(DEFAULT_RULES, [0, 1]);
  for (let t = 0; t < CAP; t++) {
    step(w, new Map());
    if (updateMatch(match, w)) {
      if (match.lastRoundWinner === DRAW) return 'draw';
      return match.lastRoundWinner === (swap ? 1 : 0) ? 'a' : 'b';
    }
  }
  return 'draw';
}

console.log(
  `rows beat columns, % of decided duels ` +
    `(${VERSUS_MAPS.length * SEEDS} per cell, sides swapped)\n`,
);
process.stdout.write('          ' + KINDS.map(([n]) => n.padStart(7)).join('') + '\n');

const averages = [];
for (const [an, a] of KINDS) {
  const row = [];
  const rates = [];
  for (const [bn, b] of KINDS) {
    if (an === bn) {
      row.push('     --');
      continue;
    }
    let aw = 0;
    let bw = 0;
    for (let m = 0; m < VERSUS_MAPS.length; m++) {
      for (let s = 0; s < SEEDS; s++) {
        const r = duel(a, b, m, 300 + s * 31, s % 2 === 1);
        if (r === 'a') aw++;
        else if (r === 'b') bw++;
      }
    }
    // Every duel a draw means neither can reach the other -- worth showing as
    // its own thing rather than as a 0% that looks like a thrashing.
    if (aw + bw === 0) {
      row.push('  never');
      continue;
    }
    const pct = (aw / (aw + bw)) * 100;
    rates.push(pct);
    row.push(`${pct.toFixed(0).padStart(6)}%`);
    void bn;
  }
  process.stdout.write(an.padEnd(10) + row.join('') + '\n');
  averages.push([an, rates.reduce((p, c) => p + c, 0) / rates.length]);
}

console.log('\naverage win rate against all others, weakest first:');
for (const [n, v] of [...averages].sort((x, y) => x[1] - y[1])) {
  console.log(`  ${n.padEnd(7)} ${v.toFixed(1).padStart(5)}%`);
}
console.log('\n"never" means every duel drew: neither tank could reach the other.');
