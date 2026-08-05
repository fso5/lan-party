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
import {
  MAX_MINES_PER_TANK,
  MINE_ARM_TICKS,
  MINE_FUSE_TICKS,
  MINE_TRIGGER_RADIUS,
  TANK_RADIUS,
} from '../src/tuning.js';

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

test('a tank can only have its allowance of mines on the ground', () => {
  /*
   * Found by mutation: halving MAX_MINES_PER_TANK broke nothing, in core or in
   * any of the four browser suites. The cap is the whole of what stops someone
   * carpeting a doorway, and it is the kind of number that gets raised for a
   * quick experiment and left.
   *
   * `nextMineTick` puts 30 ticks between mines, so this drives real steps
   * rather than calling layMine in a loop -- calling it directly would be
   * refused by the cooldown and pass for the wrong reason.
   */
  const { w, layer } = noseToNose();
  // Nothing to trip them: the victim is what makes mines go off in the other
  // tests here, and a mine exploding would hand the allowance back mid-count.
  w.tanks[1].alive = false;

  const idle = new Map([[layer.id, emptyInput()]]);
  let laid = 0;
  for (let attempt = 0; attempt < MAX_MINES_PER_TANK + 3; attempt++) {
    const before = w.mines.length;
    lay(w, layer.id);
    if (w.mines.length > before) laid++;
    // Clear of the cooldown, well short of the fuse, so a refusal is the cap
    // and nothing else.
    for (let i = 0; i < 31; i++) step(w, idle);
  }

  assert.equal(laid, MAX_MINES_PER_TANK, `laid ${laid} mines with an allowance of ${MAX_MINES_PER_TANK}`);
  assert.equal(layer.minesOut, MAX_MINES_PER_TANK);
});

test('the allowance comes back when a mine goes off', () => {
  // The other half, and the one that would stick: a counter that only ever
  // climbs leaves a player unable to lay another mine for the rest of the
  // round, with the HUD showing why and nothing explaining it.
  const { w, layer } = noseToNose();
  w.tanks[1].alive = false;
  const idle = new Map([[layer.id, emptyInput()]]);

  lay(w, layer.id);
  assert.equal(layer.minesOut, 1, 'the mine is on the ground');

  // Let it burn down to its own fuse rather than tripping it, so this is about
  // the counter and not about the trigger.
  for (let i = 0; i < MINE_FUSE_TICKS + 5; i++) step(w, idle);

  assert.equal(w.mines.length, 0, 'the fuse ran out');
  assert.equal(layer.minesOut, 0, 'and the allowance came back with it');
});

test('a mine reaches exactly as far as it says it does', () => {
  /*
   * The half nobody writes. Every other mine test here puts the victim inside
   * the trigger circle and checks it goes off, so the radius could be four
   * times what it says and the suite would agree with itself -- found exactly
   * that way, by quadrupling MINE_TRIGGER_RADIUS at the call site and watching
   * nothing fail.
   *
   * Written as a boundary rather than as "far away is safe". A first version
   * put the survivor at 1.5x the reach, which caught the quadrupling and let a
   * 60% widening through -- a mine reaching half a tank further than it should
   * is exactly the size of error that survives a loose test and changes how the
   * game plays. Just inside must go off and just outside must not, five per
   * cent either side of the real edge.
   */
  const edge = MINE_TRIGGER_RADIUS + TANK_RADIUS;

  for (const [where, factor, shouldFire] of [
    ['just inside', 0.95, true],
    ['just outside', 1.05, false],
  ] as const) {
    const { w, layer, victim } = noseToNose();
    victim.x = layer.x + edge * factor;
    victim.y = layer.y;

    lay(w, layer.id);
    assert.equal(w.mines.length, 1, `${where}: the mine went down`);

    // Past arming, well short of the fuse, so anything that happens is the
    // trigger and not the clock.
    const idle = new Map([
      [layer.id, emptyInput()],
      [victim.id, emptyInput()],
    ]);
    for (let i = 0; i < MINE_ARM_TICKS + 30; i++) step(w, idle);

    if (shouldFire) {
      assert.equal(w.mines.length, 0, `${where}: the mine should have gone off`);
      assert.equal(victim.alive, false, `${where}: and taken the tank with it`);
    } else {
      assert.equal(w.mines.length, 1, `${where}: the mine should still be waiting`);
      assert.equal(victim.alive, true, `${where}: and the tank should be alive`);
    }
  }
});
