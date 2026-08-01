import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RULES,
  DRAW,
  createMatch,
  leadingScore,
  roundOutcome,
  standings,
  teamsOnMatchPoint,
  updateMatch,
  type MatchRules,
} from '../src/rules.js';
import { createWorld } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { TICK_HZ } from '../src/tuning.js';

function fourPlayerWorld() {
  return createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 1,
    players: Array.from({ length: 4 }, (_, i) => ({ team: i, spawnIndex: i })),
  });
}

const RULES: MatchRules = { mode: 'ffa', roundsToWin: 2, intermissionTicks: 30 };

test('a round is undecided while two or more teams are alive', () => {
  const w = fourPlayerWorld();
  assert.equal(roundOutcome(w), null);

  w.tanks[0].alive = false;
  w.tanks[1].alive = false;
  assert.equal(roundOutcome(w), null, 'two teams left is still a live round');
});

test('the last team standing takes the round', () => {
  const w = fourPlayerWorld();
  for (const t of w.tanks) t.alive = false;
  w.tanks[2].alive = true;
  assert.equal(roundOutcome(w), 2);
});

test('mutual destruction is a draw, not a win for nobody', () => {
  // Not a defensive edge case: your own shell kills you and mines kill whoever
  // laid them, so two tanks trading fatal shots in the same tick is an ordinary
  // way for a round to end. Reading "no teams alive" as a winner would corrupt
  // the scoreboard the first time it happened.
  const w = fourPlayerWorld();
  for (const t of w.tanks) t.alive = false;
  assert.equal(roundOutcome(w), DRAW);

  const m = createMatch(RULES, [0, 1, 2, 3]);
  updateMatch(m, w);
  assert.equal(m.lastRoundWinner, DRAW);
  assert.equal(leadingScore(m), 0, 'a draw must score nothing for anyone');
  assert.equal(m.phase, 'intermission');
});

test('a round win scores once and starts an intermission', () => {
  const w = fourPlayerWorld();
  const m = createMatch(RULES, [0, 1, 2, 3]);

  for (const t of w.tanks) t.alive = false;
  w.tanks[1].alive = true;
  w.tick = 100;

  assert.equal(updateMatch(m, w), true, 'should report the round was decided');
  assert.equal(m.score.get(1), 1);
  assert.equal(m.phase, 'intermission');
  assert.equal(m.resumeAtTick, 130);
  assert.equal(m.round, 1, 'the round number advances when the next one starts');

  // Calling again mid-intermission must not score again -- updateMatch runs
  // every tick, so a re-award here would hand out a point 60 times a second.
  assert.equal(updateMatch(m, w), false);
  assert.equal(m.score.get(1), 1);
});

test('the next round begins when the intermission elapses', () => {
  const w = fourPlayerWorld();
  const m = createMatch(RULES, [0, 1, 2, 3]);
  for (const t of w.tanks) t.alive = false;
  w.tanks[0].alive = true;
  updateMatch(m, w);

  w.tick = m.resumeAtTick - 1;
  updateMatch(m, w);
  assert.equal(m.phase, 'intermission', 'must not resume early');

  w.tick = m.resumeAtTick;
  updateMatch(m, w);
  assert.equal(m.phase, 'playing');
  assert.equal(m.round, 2);
});

test('reaching the round target ends the match and stops scoring', () => {
  const w = fourPlayerWorld();
  const m = createMatch(RULES, [0, 1, 2, 3]);

  // Round one to team 3.
  for (const t of w.tanks) t.alive = false;
  w.tanks[3].alive = true;
  updateMatch(m, w);
  w.tick = m.resumeAtTick;
  updateMatch(m, w);

  // Round two to team 3 as well -- that is the target.
  updateMatch(m, w);
  assert.equal(m.matchWinner, 3);
  assert.equal(m.phase, 'finished');
  assert.equal(m.score.get(3), 2);

  // A finished match must be inert, however many more ticks arrive.
  for (let i = 0; i < 10; i++) {
    w.tick += 60;
    assert.equal(updateMatch(m, w), false);
  }
  assert.equal(m.score.get(3), 2, 'a finished match must not keep scoring');
});

test('every team appears on the scoreboard from the start', () => {
  // So a lobby can render standings without separately knowing the roster.
  const m = createMatch(RULES, [0, 1, 2, 3]);
  assert.deepEqual(
    standings(m),
    [
      { team: 0, score: 0 },
      { team: 1, score: 0 },
      { team: 2, score: 0 },
      { team: 3, score: 0 },
    ],
  );
});

test('standings rank by score, ties by team id', () => {
  const m = createMatch(RULES, [0, 1, 2]);
  m.score.set(0, 1);
  m.score.set(1, 3);
  m.score.set(2, 1);
  assert.deepEqual(standings(m), [
    { team: 1, score: 3 },
    { team: 0, score: 1 },
    { team: 2, score: 1 },
  ]);
});

test('match point reports every team on it, not just one', () => {
  // Several teams can sit on match point at once, and a UI that assumes one
  // would name the wrong player.
  const m = createMatch({ mode: 'ffa', roundsToWin: 3, intermissionTicks: 0 }, [0, 1, 2]);
  assert.deepEqual(teamsOnMatchPoint(m), []);

  m.score.set(2, 2);
  assert.deepEqual(teamsOnMatchPoint(m), [2]);

  m.score.set(0, 2);
  assert.deepEqual(teamsOnMatchPoint(m), [0, 2]);
});

test('teams mode differs from free-for-all only in the seating', () => {
  // There is no FFA branch anywhere -- the sim keys hostility off team id, so
  // 2v2 is just four players across two teams. This pins that, because a future
  // change that special-cases `mode` would break the equivalence silently.
  const w = createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 1,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
      { team: 0, spawnIndex: 2 },
      { team: 1, spawnIndex: 3 },
    ],
  });
  const m = createMatch({ ...DEFAULT_RULES, mode: 'teams' }, [0, 1]);

  // One tank down does not end a team round while its partner lives.
  w.tanks[0].alive = false;
  assert.equal(roundOutcome(w), null);
  assert.equal(updateMatch(m, w), false);

  // Both of team 0 down ends it for team 1.
  w.tanks[2].alive = false;
  assert.equal(roundOutcome(w), 1);
  assert.equal(updateMatch(m, w), true);
  assert.equal(m.score.get(1), 1);
});

test('the default rules are sane for a phone match', () => {
  assert.equal(DEFAULT_RULES.roundsToWin, 3);
  assert.ok(
    DEFAULT_RULES.intermissionTicks >= TICK_HZ && DEFAULT_RULES.intermissionTicks <= TICK_HZ * 6,
    'intermission should be a few seconds, not a blink or a wait',
  );
});
