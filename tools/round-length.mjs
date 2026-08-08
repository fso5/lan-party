/**
 * How long does a versus round actually take?
 *
 *     node tools/round-length.mjs [seeds]
 *
 * `DEFAULT_RULES` calls a round a draw at two minutes, and the comment on that
 * limit says the alternative is a round that "takes the evening with it". The
 * number was chosen against bot rounds resolving in a 5-18 second median. That
 * was the *median*, and nothing had ever looked at the tail.
 *
 * The question came from a real observation rather than curiosity: running the
 * WiFi harness with one idle client and three bots, round one resolved in six
 * seconds and round two took seventy. Two samples are an anecdote. This is the
 * distribution.
 *
 * ## What is simulated
 *
 * The harness lineup: four tanks on four teams -- free-for-all, which is what
 * `DEFAULT_MATCH_SIZE` fills a versus map to. All four are bots, because a
 * Player-kind tank gets no AI at all (see tools/campaign-curve.mjs for how that
 * mistake looks when it is made). So this measures bots fighting bots.
 *
 * That is a real limitation and it cuts one way: people move toward each other
 * and press the trigger, so a human round should end sooner than these. A tail
 * measured here is a lower bound on how bad the human-free case gets, not a
 * prediction of play.
 *
 * ## What the tail is made of, watched rather than assumed
 *
 * I first wrote that the long rounds were "the last two survivors circling".
 * The first half is right and the second is wrong, and the difference decides
 * whether there is anything to fix. Traced over 360 rounds, comparing the ones
 * past 30 seconds against the rest:
 *
 *                          >30s      <30s
 *     duel, two left       33.0s      6.6s      (82% of the long round)
 *     shells fired          41.6      13.3
 *     shell in the air       98%       99%
 *     movement per tank  1.60 t/s  1.31 t/s
 *     closest approach    6.2 til  11.1 til
 *
 * So it is the last two, and they are not circling: they fire more, move more,
 * and close further than in a short round. A shell is in the air essentially
 * always. What makes these rounds long is that the shots miss -- a firefight
 * at a mean 12.5 tiles on a 24-tile map, which is the game working rather than
 * an AI that has stopped trying.
 *
 * Worth knowing before anyone "hurries the endgame along", including me: the
 * lever is accuracy or arena size, not pursuit. Nothing here is a defect.
 */
import {
  createWorld,
  step,
  createMatch,
  updateMatch,
  DEFAULT_RULES,
  DEFAULT_MATCH_SIZE,
  DRAW,
  loadArena,
  VERSUS_MAPS,
  TankKind,
  TICK_HZ,
} from '@tanks/core';

import { fileURLToPath } from 'node:url';
import { requireFreshCore } from './lib/fresh-core.mjs';

// These numbers describe packages/core/dist, not packages/core/src.
requireFreshCore(fileURLToPath(new URL('..', import.meta.url)));

const SEEDS = Number(process.argv[2] ?? 200);
if (!Number.isInteger(SEEDS) || SEEDS < 1) {
  console.error(`usage: node tools/round-length.mjs [seeds]   (got "${process.argv[2]}")`);
  process.exit(2);
}

const LIMIT = DEFAULT_RULES.roundTimeLimitTicks;
// One tick past the limit, so a round that is *supposed* to be called a draw
// is observed being called one rather than cut off by this loop first.
const CAP = LIMIT + 2;
const KINDS = [TankKind.Grey, TankKind.Teal, TankKind.Yellow];

/** One free-for-all round; returns how many ticks it took. */
function roundTicks(map, seed) {
  const arena = loadArena(map);
  const bots = [];
  const fillTo = Math.min(DEFAULT_MATCH_SIZE, arena.spawns.length);
  for (let s = 0; s < fillTo; s++) {
    bots.push({ kind: KINDS[s % KINDS.length], team: s, spawnIndex: s });
  }
  const w = createWorld({ arena, seed, players: [], bots });
  const match = createMatch(DEFAULT_RULES, bots.map((_, i) => i));
  for (let t = 0; t < CAP; t++) {
    step(w, new Map());
    if (updateMatch(match, w)) {
      const ticks = t + 1;
      /*
       * Two different endings both report DRAW, and conflating them makes the
       * table lie. `DRAW` is "no survivors", which the rules call reachable and
       * not rare -- two tanks killing each other on the same tick. The *time
       * limit* is the ending this tool exists to look for, and it is told apart
       * by the clock, not the winner. A first run of this reported three
       * "drawn on the limit" in six hundred rounds while the longest round it
       * had seen was 106 seconds against a 120 second limit.
       */
      return { ticks, draw: match.lastRoundWinner === DRAW, timedOut: ticks >= LIMIT };
    }
  }
  return { ticks: CAP, draw: true, timedOut: true };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const secs = (t) => (t / TICK_HZ).toFixed(1);

console.log(`free-for-all rounds, ${SEEDS} seeds a map, all bots`);
console.log(`draw limit is ${secs(LIMIT)}s\n`);
console.log('map            median    p90    p99    max   >30s   >60s  no-survivor  timeout');

const all = [];
for (const map of VERSUS_MAPS) {
  const runs = [];
  for (let s = 0; s < SEEDS; s++) runs.push(roundTicks(map, 7000 + s * 31));
  all.push(...runs);
  const t = runs.map((r) => r.ticks).sort((a, b) => a - b);
  const over = (n) => t.filter((x) => x > TICK_HZ * n).length;
  const draws = runs.filter((r) => r.draw).length;
  const timeouts = runs.filter((r) => r.timedOut).length;
  console.log(
    `${map.name.padEnd(12)} ${secs(pct(t, 50)).padStart(7)}s ${secs(pct(t, 90)).padStart(5)}s ` +
      `${secs(pct(t, 99)).padStart(5)}s ${secs(t[t.length - 1]).padStart(5)}s ` +
      `${String(over(30)).padStart(5)} ${String(over(60)).padStart(6)} ${String(draws).padStart(12)} ${String(timeouts).padStart(8)}`,
  );
}

const t = all.map((r) => r.ticks).sort((a, b) => a - b);
const over = (n) => t.filter((x) => x > TICK_HZ * n).length;
console.log(
  `\nall ${t.length} rounds: median ${secs(pct(t, 50))}s, p90 ${secs(pct(t, 90))}s, ` +
    `p99 ${secs(pct(t, 99))}s, max ${secs(t[t.length - 1])}s`,
);
console.log(
  `longer than 30s: ${((over(30) / t.length) * 100).toFixed(1)}%   ` +
    `longer than 60s: ${((over(60) / t.length) * 100).toFixed(1)}%   ` +
    `no survivors: ${((all.filter((r) => r.draw).length / t.length) * 100).toFixed(1)}%   ` +
    `hit the ${secs(LIMIT)}s limit: ${((all.filter((r) => r.timedOut).length / t.length) * 100).toFixed(1)}%`,
);

// State the conclusion rather than leaving a table to be eyeballed: the whole
// question is whether the tail is long enough to spoil a game passed around a
// room, and a median does not answer that.
const p90 = pct(t, 90) / TICK_HZ;
console.log(
  p90 > 45
    ? `\nThe tail is long: nine rounds in ten finish inside ${p90.toFixed(0)}s, which is not a quick round.`
    : `\nThe tail is contained: nine rounds in ten finish inside ${p90.toFixed(0)}s.`,
);
