/**
 * Match rules: modes, rounds and scoring.
 *
 * The simulation knows how to run one fight to its end and nothing more --
 * `isMatchOver` reports when a single team is left standing. Everything a
 * *match* needs on top of that lives here: how many rounds, who is winning,
 * when the next round starts, and who took it.
 *
 * Kept out of `WorldState` deliberately. The world is stepped deterministically
 * and replayed during client reconciliation; rolling a rewind back over the
 * scoreboard would award and un-award rounds as the client re-simulates. Match
 * state advances once per real round, on the host, and rides the wire as a
 * discrete event rather than being derived on both ends.
 *
 * ## Free-for-all is teams-of-one
 *
 * There is no separate FFA code path anywhere, because the simulation already
 * keys every hostility decision off `team`. Four players on four teams *is*
 * free-for-all. `MatchMode` exists only so a lobby can say which arrangement it
 * means and so the UI can label it; the rules below never branch on it.
 */

import { livingTeams, type WorldState } from './sim.js';
import { TICK_HZ } from './tuning.js';

export type MatchMode = 'ffa' | 'teams';

export interface MatchRules {
  mode: MatchMode;
  /** Rounds a side must win to take the match. */
  roundsToWin: number;
  /** Pause between a round ending and the next beginning. */
  intermissionTicks: number;
  /**
   * Longest a round may run before it is called a draw.
   *
   * Without this a round simply does not end when the survivors cannot kill
   * each other, and that is reachable rather than theoretical: two Brown tanks
   * on Pillars never resolve, measured over six seeds and five minutes of game
   * time each. Brown does not move and its shells bounce once, and the pillars
   * leave no such path between those two starts. Two people hiding behind
   * opposite pillars do the same thing, which is the version that matters --
   * this is a game passed around a room, and a round that cannot end takes the
   * evening with it.
   */
  roundTimeLimitTicks: number;
}

export const DEFAULT_RULES: MatchRules = {
  mode: 'ffa',
  roundsToWin: 3,
  // Long enough to read who won and see the explosion land, short enough that
  // nobody reaches for their phone's home button.
  intermissionTicks: TICK_HZ * 3,
  // Measured before choosing: bot rounds resolve in a 5-18s median depending on
  // map and count, and the slowest of 72 runs took 100s. Two minutes sits well
  // clear of legitimate play while still ending a stalemate inside the span of
  // somebody's patience.
  //
  // Re-measured later over 600 free-for-all rounds, three versus maps, all bots
  // (tools/round-length.mjs), because two minutes is a long time to be told the
  // round is still going: median 12.7s, p90 34.6s, p99 61.8s, longest 106.2s.
  // Not one round reached this limit. So it is a backstop rather than a
  // participant -- and 106 against 120 says it is not dead code either, which
  // is the reason not to tighten it on the strength of a median.
  //
  // What the tail *is* made of: 13.8% of rounds ran past 30s and 1.7% past 60s,
  // and it is the last two survivors -- 82% of a long round is the 1v1. They
  // are not circling, which is what this comment used to say before anyone
  // looked: over the duel they fire three times as many shells as in a short
  // round, move faster, and close further, with a shell in the air 98% of
  // ticks. The rounds are long because the shots miss at a mean 12.5 tiles on
  // a 24-tile map. So the lever, if the endgame ever wants hurrying along, is
  // accuracy or arena size rather than pursuit -- and none of it is a defect.
  //
  // People close and shoot, so a human round should end sooner still; these
  // numbers bound the bot case rather than predicting play.
  roundTimeLimitTicks: TICK_HZ * 120,
};

export type MatchPhase = 'playing' | 'intermission' | 'finished';

/** A round with no survivors at all. Reachable, and not rare. */
export const DRAW = -1;

export interface MatchState {
  rules: MatchRules;
  /** 1-based, so the HUD can say "Round 3" without arithmetic. */
  round: number;
  /** Rounds won, keyed by team. Teams with no wins are present at 0. */
  score: Map<number, number>;
  phase: MatchPhase;
  /** Tick the current intermission ends. Meaningless while playing. */
  resumeAtTick: number;
  /** Tick the current round began, for the time limit. */
  roundStartTick: number;
  /** Team that took the last round, DRAW, or null before any round ends. */
  lastRoundWinner: number | null;
  /** Team that took the match, or null while it is still running. */
  matchWinner: number | null;
}

export function createMatch(rules: MatchRules, teams: number[]): MatchState {
  const score = new Map<number, number>();
  // Seed every team at zero so a scoreboard can be rendered from this alone,
  // without the UI having to know the roster separately.
  for (const t of teams) score.set(t, 0);

  return {
    rules,
    round: 1,
    score,
    phase: 'playing',
    resumeAtTick: 0,
    roundStartTick: 0,
    lastRoundWinner: null,
    matchWinner: null,
  };
}

/**
 * Who won the round that just ended, or null if it has not ended.
 *
 * Returns DRAW when nobody is left. That is not a defensive edge case in this
 * game: your own shell kills you and mines kill whoever laid them, so two tanks
 * trading fatal shots in the same tick is an ordinary way for a round to end.
 * Treating "no teams alive" as "team undefined wins" would corrupt the
 * scoreboard the first time it happened.
 */
export function roundOutcome(world: WorldState): number | null {
  const alive = livingTeams(world);
  if (alive.size > 1) return null;
  if (alive.size === 0) return DRAW;
  return [...alive][0];
}

/**
 * Advance match state. Call once per simulation tick, on the host only.
 *
 * Returns true on the tick a round is decided, so the caller can fire the
 * round-over event without polling for a change.
 */
export function updateMatch(match: MatchState, world: WorldState): boolean {
  if (match.phase === 'finished') return false;

  if (match.phase === 'intermission') {
    if (world.tick >= match.resumeAtTick) {
      match.phase = 'playing';
      match.round++;
      match.roundStartTick = world.tick;
    }
    return false;
  }

  // Time out before asking who is left: a round nobody can win is exactly the
  // case where roundOutcome keeps returning null forever.
  const timedOut = world.tick - match.roundStartTick >= match.rules.roundTimeLimitTicks;
  const winner = timedOut ? DRAW : roundOutcome(world);
  if (winner === null) return false;

  if (winner !== DRAW) {
    const next = (match.score.get(winner) ?? 0) + 1;
    match.score.set(winner, next);

    if (next >= match.rules.roundsToWin) {
      match.lastRoundWinner = winner;
      match.matchWinner = winner;
      match.phase = 'finished';
      return true;
    }
  }

  // A draw costs everyone the round and scores nothing -- the alternative,
  // awarding it to the last tank to die, rewards being killed slightly later.
  match.lastRoundWinner = winner;
  match.phase = 'intermission';
  match.resumeAtTick = world.tick + match.rules.intermissionTicks;
  return true;
}

/** Highest score any team holds. Useful for a "match point" indicator. */
export function leadingScore(match: MatchState): number {
  let best = 0;
  for (const v of match.score.values()) if (v > best) best = v;
  return best;
}

/**
 * Teams one round from taking the match.
 *
 * Plural on purpose: several teams can sit on match point simultaneously, and a
 * UI that assumes one would show the wrong name.
 */
export function teamsOnMatchPoint(match: MatchState): number[] {
  const need = match.rules.roundsToWin - 1;
  const out: number[] = [];
  for (const [team, v] of match.score) if (v === need) out.push(team);
  return out.sort((a, b) => a - b);
}

/** Scoreboard rows, ranked. Ties keep a stable order by team id. */
export function standings(match: MatchState): { team: number; score: number }[] {
  return [...match.score.entries()]
    .map(([team, score]) => ({ team, score }))
    .sort((a, b) => b.score - a.score || a.team - b.team);
}
