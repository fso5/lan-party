/**
 * The campaign's rules and its generated missions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BONUS_LIFE_EVERY,
  CAMPAIGN_MISSIONS,
  FIRST_RUN_MISSIONS,
  KIND_INTRODUCED,
  START_LIVES,
  campaignMission,
  enemyCount,
  generateMission,
  mapById,
  missionCleared,
  startRun,
  tankLost,
} from '../src/campaign.js';
import { loadArena, MISSIONS, VERSUS_MAPS } from '../src/maps/index.js';
import { createWorld } from '../src/sim.js';
import { TankKind } from '../src/types.js';

test('a first run is twenty missions on three lives', () => {
  const run = startRun(false);
  assert.deepEqual(run, { mission: 1, lives: START_LIVES, length: FIRST_RUN_MISSIONS });
  assert.equal(startRun(true).length, CAMPAIGN_MISSIONS);
});

test('every fifth mission cleared earns a life, and only those', () => {
  let run = startRun(true);
  const lives: number[] = [];
  for (let i = 0; i < 12; i++) {
    const r = missionCleared(run);
    lives.push(r.run.lives);
    assert.equal(r.bonusLife, (i + 1) % BONUS_LIFE_EVERY === 0, `after clearing mission ${i + 1}`);
    run = r.run;
  }
  assert.deepEqual(lives, [3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5]);
  assert.equal(run.mission, 13);
});

test('clearing mission 20 on the first run finishes it and unlocks the hundred', () => {
  const r = missionCleared({ mission: 20, lives: 2, length: FIRST_RUN_MISSIONS });
  assert.equal(r.finished, true);
  assert.equal(r.unlocksHundred, true);
  // After unlocking, 20 is just a milestone.
  const later = missionCleared({ mission: 20, lives: 2, length: CAMPAIGN_MISSIONS });
  assert.equal(later.finished, false);
  assert.equal(later.unlocksHundred, false);
  assert.equal(later.run.mission, 21);
  // And 100 ends the full run, without unlocking anything further.
  const last = missionCleared({ mission: 100, lives: 1, length: CAMPAIGN_MISSIONS });
  assert.equal(last.finished, true);
  assert.equal(last.unlocksHundred, false);
});

test('losing a tank costs a life, and the last one ends the run', () => {
  let r = tankLost({ mission: 7, lives: 2, length: 20 });
  assert.deepEqual(r, { run: { mission: 7, lives: 1, length: 20 }, gameOver: false });
  r = tankLost(r.run);
  assert.equal(r.gameOver, true);
});

test('missions one to five are the hand-made ones', () => {
  for (const m of MISSIONS) assert.equal(campaignMission(m.id), m);
});

test('every mission from 1 to 100 builds a playable world', () => {
  for (let n = 1; n <= CAMPAIGN_MISSIONS; n++) {
    const m = campaignMission(n);
    assert.equal(m.id, n);
    const arena = loadArena(m);
    assert.equal(arena.width, 24, `mission ${n} width`);
    assert.equal(arena.height, 19, `mission ${n} height`);
    assert.ok(arena.spawns.length >= 1, `mission ${n} has no player spawn`);
    assert.ok(arena.enemies.length >= 1, `mission ${n} has no enemies`);
    const w = createWorld({ arena, seed: n, players: [{ team: 0, spawnIndex: 0 }] });
    assert.equal(w.tanks.length, 1 + arena.enemies.length);
  }
});

test('a generated mission is the same every time', () => {
  for (const n of [6, 37, 100]) assert.deepEqual(generateMission(n).rows, generateMission(n).rows);
  assert.notDeepEqual(generateMission(40).rows, generateMission(41).rows);
});

test('generated missions only field kinds the campaign has introduced, and debut each on time', () => {
  for (let n = 6; n <= CAMPAIGN_MISSIONS; n++) {
    const kinds = loadArena(campaignMission(n)).enemies.map((e) => e.kind as TankKind);
    assert.equal(kinds.length, enemyCount(n), `mission ${n} enemy count`);
    for (const k of kinds) {
      const from = KIND_INTRODUCED.find(([kind]) => kind === k)![1];
      assert.ok(from <= n, `mission ${n} fields ${TankKind[k]} before its debut at ${from}`);
    }
    const debut = KIND_INTRODUCED.find(([, from]) => from === n);
    if (debut) assert.ok(kinds.includes(debut[0]), `${TankKind[debut[0]]} does not debut in mission ${n}`);
  }
});

test('the hundred field about as many tanks as the original', () => {
  let total = 0;
  for (let n = 1; n <= CAMPAIGN_MISSIONS; n++) total += loadArena(campaignMission(n)).enemies.length;
  // The original: 540 across its hundred.
  assert.ok(total > 480 && total < 620, `${total} enemy tanks across the campaign`);
});

test('a networked match can name any map by id', () => {
  assert.equal(mapById(1), MISSIONS[0]);
  assert.equal(mapById(57)!.name, 'Mission 57');
  assert.equal(mapById(VERSUS_MAPS[0].id), VERSUS_MAPS[0]);
  assert.equal(mapById(0), undefined);
});

test('co-op: a clear goes on, a wipe starts over, the clock replays, and 20 completes', async () => {
  const { coopNext, coopOutcome, COOP_MISSIONS } = await import('../src/campaign.js');
  assert.deepEqual(coopNext(7, 'cleared'), { mission: 8, completed: false });
  assert.deepEqual(coopNext(7, 'failed'), { mission: 1, completed: false });
  assert.deepEqual(coopNext(7, 'timeout'), { mission: 7, completed: false });
  assert.deepEqual(coopNext(COOP_MISSIONS, 'cleared'), { mission: 1, completed: true });
  assert.equal(coopOutcome(0), 'cleared');
  assert.equal(coopOutcome(1), 'failed');
  assert.equal(coopOutcome(-1), 'timeout');
  assert.equal(coopOutcome(null), 'timeout');
});

test('every co-op mission seats two players apart', () => {
  for (let n = 1; n <= 20; n++) {
    const arena = loadArena(campaignMission(n));
    assert.ok(arena.spawns.length >= 2, `mission ${n} has no place for a second player`);
    const [a, b] = arena.spawns;
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 1, `mission ${n} stacks the two players`);
  }
});
