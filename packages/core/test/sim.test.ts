/**
 * Simulation rules that are neither physics primitives nor match scoring.
 *
 * sim.ts is exercised by nearly every other suite -- it is what `step` is --
 * but that traffic is all incidental. Nothing was checking the rules it
 * enforces in their own right, which a mutation run made plain: making mines
 * live the instant they are laid broke no test anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, step } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { emptyInput } from '../src/types.js';
import { MINE_ARM_TICKS, MINE_TRIGGER_RADIUS, TANK_RADIUS } from '../src/tuning.js';

/** Two tanks on opposing teams, standing close enough to trigger a mine. */
function noseToNose() {
  const w = createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 7,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
    ],
  });
  const [layer, victim] = w.tanks;
  // Well inside the trigger circle, so the only thing keeping the mine quiet
  // is the arming delay.
  victim.x = layer.x + (MINE_TRIGGER_RADIUS + TANK_RADIUS) * 0.5;
  victim.y = layer.y;
  return { w, layer, victim };
}

const lay = (w: ReturnType<typeof noseToNose>['w'], id: number) =>
  step(w, new Map([[id, { ...emptyInput(), layMine: true }]]));

test('a mine cannot be triggered before it arms', () => {
  /*
   * Found by mutation: dropping the `w.tick >= m.armTick` guard survived the
   * whole suite.
   *
   * The delay is not about the tank that laid it -- the proximity check
   * already skips the owner, so that half is safe either way. It is about
   * everyone else. Without it a mine laid next to an enemy detonates on the
   * tick it appears, which turns the mine from a trap you set into a melee
   * weapon with no counterplay: whoever presses the button first wins, and the
   * other player never sees it coming.
   */
  const { w, layer, victim } = noseToNose();
  lay(w, layer.id);
  assert.equal(w.mines.length, 1, 'no mine was laid');

  const empty = new Map();
  for (let i = 0; i < MINE_ARM_TICKS - 2; i++) step(w, empty);

  assert.equal(w.mines.length, 1, 'the mine went off before it had armed');
  assert.ok(victim.alive, 'the enemy was killed by a mine that had not armed yet');
});

test('and it does go off once it has', () => {
  // The other half. A delay long enough to never trigger would also pass the
  // test above, and would be a mine that does nothing at all.
  const { w, layer, victim } = noseToNose();
  lay(w, layer.id);

  const empty = new Map();
  for (let i = 0; i < MINE_ARM_TICKS + 5; i++) step(w, empty);

  assert.equal(w.mines.length, 0, 'the mine never triggered on an enemy standing on it');
  assert.ok(!victim.alive, 'the mine detonated without killing the enemy standing on it');
});

test('an armed mine ignores the tank that laid it', () => {
  /*
   * Documented in sim.ts as "otherwise you could never drive away from your
   * own mine" -- true, and worth pinning, because the arming delay is not what
   * provides it. Waiting out the delay with only the owner nearby is the case
   * that tells the two rules apart.
   */
  const { w, layer, victim } = noseToNose();
  // Send the other player away, so the owner is the only tank in range.
  victim.x = layer.x + 8;

  lay(w, layer.id);
  const empty = new Map();
  for (let i = 0; i < MINE_ARM_TICKS + 30; i++) step(w, empty);

  assert.equal(w.mines.length, 1, 'the mine went off under the tank that laid it');
  assert.ok(layer.alive, 'a tank was killed by its own mine');
});
