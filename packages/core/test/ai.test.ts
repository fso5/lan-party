/**
 * Enemy AI behaviour.
 *
 * ai.ts had no behavioural coverage. It is exercised by determinism.test.ts --
 * the mission worlds there are full of enemies -- but that suite compares two
 * runs of the same code against each other, so it is blind to what the AI
 * actually decides. Making `stepAi` return an empty input on every even tick
 * left the whole suite green: bots that stand still half the time are perfectly
 * reproducible.
 *
 * What that misses is the entire product. This is a Tanks! clone, and most of
 * Tanks! is the bots. An AI that quietly stopped aiming would ship.
 *
 * So these tests are about conduct, not reproducibility, and they avoid pinning
 * the numbers that are meant to be tuned -- no assertions on how often a Green
 * tank fires or how wide its aim error is. They pin the two claims ai.ts makes
 * about itself: a solved shot is one the shell can really make, and a bot with
 * an enemy in front of it does something about it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solveShot, directAngleTo, stepAi } from '../src/ai.js';
import { createWorld, step } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { dcos, dsin } from '../src/math.js';
import { TankKind, emptyInput } from '../src/types.js';
import { TANK_SPECS } from '../src/tuning.js';

/** Two tanks on opposing teams, plus one bot that will do the shooting. */
function botVsPlayer() {
  const arena = loadArena(VERSUS_MAPS[0]);
  return createWorld({
    arena,
    seed: 4242,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
    ],
    bots: [{ kind: TankKind.Brown, team: 1, spawnIndex: 2 }],
  });
}

test('a solved shot is one the shell can actually make', () => {
  /*
   * The claim in ai.ts's own docstring: "Every shot the AI takes is provably
   * achievable, because it was found using the same code the shell will
   * actually use."
   *
   * Checking that by re-running the tracer would be circular -- it would only
   * prove the tracer agrees with itself. So this fires a real shell into the
   * real simulation at the angle the solver returned, and watches where it
   * goes. If the solver is wrong about the geometry, the shell misses.
   */
  const w = botVsPlayer();
  const shooter = w.tanks[0];
  const victim = w.tanks.find((t) => t.team !== shooter.team)!;

  const solution = solveShot(w, shooter, victim.x, victim.y);
  assert.ok(solution, 'no firing solution between two spawn points on an open versus map');

  shooter.turretAngle = solution.angle;
  step(w, new Map([[shooter.id, { moveX: 0, moveY: 0, aimX: dcos(solution.angle), aimY: dsin(solution.angle), fire: true, layMine: false }]]));

  const shell = w.shells.find((s) => s.ownerId === shooter.id);
  assert.ok(shell, 'the shot was solved but no shell was fired');

  // Follow it until it dies, and record how close it ever came. Distance to
  // the victim's spawn, not to the victim: nothing is driving them, so they
  // are still standing on it.
  let closest = Infinity;
  const empty = new Map();
  for (let i = 0; i < 60 * 13 && w.shells.some((s) => s.id === shell.id); i++) {
    const live = w.shells.find((s) => s.id === shell.id)!;
    closest = Math.min(closest, Math.hypot(live.x - victim.x, live.y - victim.y));
    step(w, empty);
  }

  // A tile. The solver aims at a point and the shell has width, so demanding
  // it pass through the exact centre would be pinning noise.
  assert.ok(
    closest < 1,
    `the solved shot never came closer than ${closest.toFixed(2)} tiles to its target`,
  );

  /*
   * A bound on the path, which is weaker than it looks -- read before relying
   * on it.
   *
   * It does not test the solver's stated preference for the shortest route.
   * Flipping `travel < best.travel` to `>` leaves this whole file green, and
   * measuring says why: between these two spawns the sweep finds exactly one
   * valid angle, so picking the minimum and picking the maximum pick the same
   * shot. No threshold can separate them here. Catching that would need a
   * position with a direct shot and a bank shot both available, which is
   * fiddly to construct and would pin this map's geometry into the test.
   *
   * So "prefers the shortest travel distance" is currently unverified, and I
   * am leaving it that way rather than pretending otherwise. What this does
   * catch is a tracer that reports a wildly indirect path for a target in
   * plain line of sight -- measured at 0.96 of the straight line, the fan of
   * sampled angles being why it is not exactly 1.
   */
  const straight = Math.hypot(victim.x - shooter.x, victim.y - shooter.y);
  assert.ok(
    solution.travel < straight * 1.5,
    `solved a ${solution.travel.toFixed(1)}-tile path to a target ${straight.toFixed(1)} tiles away ` +
      `-- a bank shot was preferred over the direct one`,
  );
});

test('solveShot refuses a target it cannot reach', () => {
  /*
   * The other half of the claim. A solver that returned an angle regardless
   * would pass the test above by luck on an open map, and would have the AI
   * firing into walls for the rest of the match.
   *
   * Outside the arena is the unambiguous case: the border is sealed, so no
   * trace can arrive, and no amount of bouncing changes that.
   */
  const w = botVsPlayer();
  const shooter = w.tanks[0];
  assert.equal(solveShot(w, shooter, -50, -50), null, 'solved a shot to a point off the map');
});

test('a bot with an enemy in front of it does something', () => {
  /*
   * The liveness check, and the one that catches an AI which has stopped
   * thinking. Deliberately weak about *what* it does -- driving, turning and
   * shooting are all fine, and which one it picks is tuning. Doing nothing at
   * all, for a hundred ticks, with a live enemy on the map, is not.
   */
  const w = botVsPlayer();
  const bot = w.tanks.find((t) => t.ai)!;
  assert.ok(bot, 'no AI-controlled tank in a world built with a bot');

  let acted = 0;
  for (let i = 0; i < 100; i++) {
    const input = stepAi(w, bot);
    if (input.fire || input.layMine || input.moveX !== 0 || input.moveY !== 0) acted++;
    step(w, new Map([[bot.id, input]]));
  }

  assert.ok(acted > 0, 'the bot issued an empty input on all 100 ticks');
});

test('a bot with nothing to shoot at still does not crash', () => {
  // Every enemy dead is a real state -- it is the tick a round ends on, and
  // the AI runs during it.
  const w = botVsPlayer();
  const bot = w.tanks.find((t) => t.ai)!;
  for (const t of w.tanks) if (t.id !== bot.id) t.alive = false;

  const input = stepAi(w, bot);
  assert.equal(input.fire, false, 'fired with no living enemy');
  assert.equal(bot.ai!.focusId, -1, 'kept a focus target that is no longer alive');
});

test('directAngleTo points where it says', () => {
  // Cardinals, because a sign slip here aims every bot at the mirror image of
  // its target and still looks plausible in a screenshot.
  const cases: [number, number, number, number][] = [
    [0, 0, 1, 0],
    [0, 0, 0, 1],
    [0, 0, -1, 0],
    [0, 0, 0, -1],
  ];
  for (const [x0, y0, x1, y1] of cases) {
    const a = directAngleTo(x0, y0, x1, y1);
    assert.ok(
      Math.abs(dcos(a) - (x1 - x0)) < 0.02 && Math.abs(dsin(a) - (y1 - y0)) < 0.02,
      `angle ${a.toFixed(3)} does not point from (${x0},${y0}) to (${x1},${y1})`,
    );
  }
});

test('a bot keeps shooting where you were, not where you are', () => {
  /*
   * `reactionTicks` is described in tuning.ts as the fairness knob, and the
   * mutation that removes it -- re-solving every tick instead -- was caught by
   * nothing. Worth pinning, and worth pinning accurately, because measuring it
   * showed the description was wrong.
   *
   * It is not a delay before firing. A bot whose turret already points at its
   * solution fires within two ticks whatever the number says: Brown at 55,
   * Grey at 40 and Teal at 26 all fired on tick 2 in a probe that pre-aimed
   * them. What the delay actually gates is *re-solving*. Between solutions the
   * bot keeps aiming at the spot it worked out, so a target that moves is shot
   * at where it used to be -- which is the window to dodge, arrived at by a
   * different route than the comment claimed.
   *
   * Brown because it is immobile: a mobile bot dodges, and dodging deliberately
   * invalidates its own solution, which would muddle what is being measured.
   */
  const w = botVsPlayer();
  const bot = w.tanks.find((t) => t.kind === TankKind.Brown)!;
  const player = w.tanks[0];
  const spec = TANK_SPECS[TankKind.Brown];

  // A clear line along an open row, so a solution exists at all.
  player.x = 5.5;
  player.y = 2.5;
  bot.x = 15.5;
  bot.y = 2.5;

  const idle = new Map([[player.id, emptyInput()]]);
  step(w, idle);
  const solved = bot.ai!.aimAngle;
  assert.equal(bot.ai!.aimValid, true, 'the bot should have a solution to start from');

  // Move the target a long way along the same row. Everything about the right
  // answer has changed; the bot must not know that yet.
  player.x = 9.5;
  for (let i = 0; i < spec.reactionTicks - 4; i++) step(w, idle);
  assert.equal(
    bot.ai!.aimAngle,
    solved,
    'inside the reaction window the bot must still be aiming at the old spot',
  );

  // Past the window it is allowed to notice.
  for (let i = 0; i < 12; i++) step(w, idle);
  assert.notEqual(
    bot.ai!.aimAngle,
    solved,
    'once the window passes the bot must re-solve against where the target is now',
  );
});
