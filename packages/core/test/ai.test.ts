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

test('a bot that can move never wedges', async () => {
  /*
   * A bot stuck against geometry is a free kill in the campaign and a dead
   * opponent in versus, and nothing reports it -- the match runs on perfectly
   * well with a tank that has quietly given up. Nothing checked it either.
   *
   * Measured as the longest unbroken run of ticks where a tank does not move at
   * all, which needs no distance threshold to interpret. The first attempt did
   * use one -- "half a tile in five seconds" -- and gave an answer that was
   * really a property of the number chosen: the smallest observed span was
   * 0.70 against a 0.5 bar. It also could not tell a wedged bot from one
   * holding still to line up a shot, which is correct behaviour and looks
   * identical from the outside.
   *
   * Frozen ticks separate them. Aiming is bounded by fireCooldown, tens of
   * ticks; wedged is unbounded. Measured across the versus maps: 0.0s for every
   * bot bar one brief 0.9s on The Moat. The bar is 3s, so a legitimate pause
   * has room and a wedge -- which runs to tens of seconds -- does not.
   *
   * Everyone is revived each tick: this is about behaviour, not survival, and a
   * dead bot trivially does not move.
   */
  const { TICK_HZ } = await import('../src/tuning.js');
  const SECONDS = 30;
  const LIMIT = TICK_HZ * 3;
  const STILL = 1e-4;

  const roamers = [TankKind.Grey, TankKind.Teal, TankKind.Yellow, TankKind.Black];

  for (const map of VERSUS_MAPS) {
    const arena = loadArena(map);
    const w = createWorld({
      arena,
      seed: 31,
      players: [],
      bots: roamers.map((kind, i) => ({ kind, team: i, spawnIndex: i })),
    });

    const last = new Map(w.tanks.map((t) => [t.id, { x: t.x, y: t.y }]));
    const run = new Map(w.tanks.map((t) => [t.id, 0]));

    for (let tick = 0; tick < TICK_HZ * SECONDS; tick++) {
      for (const t of w.tanks) t.alive = true;
      step(w, new Map());
      for (const t of w.tanks) {
        if (!TANK_SPECS[t.kind].mobile) continue;
        const p = last.get(t.id)!;
        const moved = Math.hypot(t.x - p.x, t.y - p.y);
        last.set(t.id, { x: t.x, y: t.y });
        const r = moved < STILL ? run.get(t.id)! + 1 : 0;
        run.set(t.id, r);
        assert.ok(
          r < LIMIT,
          `${map.name}: tank ${t.id} (${TankKind[t.kind]}) has not moved for ${(r / TICK_HZ).toFixed(1)}s`,
        );
      }
    }
  }
});

test('a bot dodges its own shell once that shell can kill it', async () => {
  /*
   * The dodge logic used to skip every shell the tank owned, so a bot avoided
   * everyone's fire except the one shot most likely to kill it. Measured across
   * 72 four-bot matches before the fix: 18% of all deaths were self-inflicted,
   * and 24-31% of each bank-shooting kind's own deaths. Afterwards, own-shell
   * deaths fell from 31 to 4.
   *
   * The shot solver does refuse angles that come back at the shooter, which is
   * why this is not obvious -- but it checks where the shooter is at the moment
   * of firing, and a roamer then drives on into the ricochet.
   *
   * Skipping an own shell while it is still inside the self-arm grace period
   * remains correct: it cannot hurt anyone yet, and fleeing it would make a
   * tank run from every shot it takes. So both halves are checked here.
   */
  const { TANK_SPECS } = await import('../src/tuning.js');

  // One roamer, alone, so nothing but its own shell can move it.
  const makeWorld = () =>
    createWorld({
      arena: loadArena(VERSUS_MAPS[0]),
      seed: 5,
      players: [],
      bots: [{ kind: TankKind.Grey, team: 0, spawnIndex: 0 }],
    });

  const profile = TANK_SPECS[TankKind.Grey].shell;

  const runWith = (age: number) => {
    const w = makeWorld();
    const tank = w.tanks[0];
    const startX = tank.x;
    const startY = tank.y;

    // A shell of the tank's own, bearing down on it from the left.
    w.shells.push({
      id: 1,
      ownerId: tank.id,
      team: tank.team,
      x: tank.x - 2,
      y: tank.y,
      vx: profile.speed,
      vy: 0,
      radius: profile.radius,
      bouncesLeft: 0,
      bornTick: w.tick - age,
      selfArmDelay: profile.selfArmDelay,
    });

    // A few ticks is enough to see whether it steps off the line. Perpendicular
    // travel is what dodging looks like; the shell comes in flat along y.
    for (let i = 0; i < 12; i++) step(w, new Map());
    return { sideways: Math.abs(tank.y - startY), forward: Math.abs(tank.x - startX) };
  };

  const armed = runWith(profile.selfArmDelay + 5);
  const notYet = runWith(0);

  assert.ok(
    armed.sideways > notYet.sideways,
    `an armed own shell should push the tank off the line: moved ${armed.sideways.toFixed(3)} ` +
      `sideways against ${notYet.sideways.toFixed(3)} for one that cannot hurt it yet`,
  );
});

test('a mine layer walks off its own mine before the fuse runs out', async () => {
  /**
   * A mine never proximity-triggers on the tank that laid it, so the fuse is
   * the only way it can kill its owner -- and that is exactly how it happened.
   * Of 216 deaths across 72 four-bot matches, 11 were the victim's own mine,
   * and every one of the 11 was the mine at age 301 out of a 300-tick fuse,
   * with the owner a mean 1.12 tiles from it. None was a firefight going wrong;
   * all were a tank standing on its own mine for five seconds. Afterwards: 0.
   *
   * Two properties, because either alone is satisfiable by a bug. Leaving early
   * enough to get clear is the fix; not leaving while there is still time is
   * what keeps a mine layer from spending its life running away from its own
   * ordnance instead of fighting.
   */
  const { MINE_BLAST_RADIUS, MINE_FUSE_TICKS, TANK_RADIUS: R } = await import('../src/tuning.js');
  const danger = MINE_BLAST_RADIUS + R;

  // Yellow is the slow mine layer, so it is the one with the least room for the
  // escape estimate to be wrong. Alone, so nothing else can move it.
  const makeWorld = () => {
    const w = createWorld({
      arena: loadArena(VERSUS_MAPS[0]),
      seed: 11,
      players: [],
      bots: [{ kind: TankKind.Yellow, team: 0, spawnIndex: 0 }],
    });
    const tank = w.tanks[0];
    w.mines.push({
      id: 99,
      ownerId: tank.id,
      team: tank.team,
      x: tank.x,
      y: tank.y,
      fuseTick: w.tick + MINE_FUSE_TICKS,
      armTick: w.tick + 1,
    });
    return { w, tank, mine: w.mines[0] };
  };

  // Wandering is the only other thing that moves this tank, and it would carry
  // it off the mine by luck rather than by decision. Pinning the wander target
  // to where the tank already stands holds it still, so any movement at all is
  // the mine escape and nothing else.
  const holdStill = (w: ReturnType<typeof makeWorld>['w'], tank: (typeof w)['tanks'][0]) => {
    const ai = tank.ai!;
    ai.targetX = tank.x;
    ai.targetY = tank.y;
    ai.repathTick = w.tick + 10_000;
  };

  {
    const { w, tank, mine } = makeWorld();
    // Halfway through the fuse there is time in hand, and the tank should still
    // be free to do something else.
    for (let i = 0; i < MINE_FUSE_TICKS / 2; i++) {
      holdStill(w, tank);
      step(w, new Map());
    }
    const moved = Math.hypot(tank.x - mine.x, tank.y - mine.y);
    assert.ok(
      moved < 1e-6,
      `with half the fuse left the tank should not be fleeing yet, but it moved ${moved.toFixed(3)} tiles`,
    );
  }

  {
    const { w, tank, mine } = makeWorld();
    const fuseTick = mine.fuseTick;
    let atFuse = 0;
    while (w.tick < fuseTick) {
      holdStill(w, tank);
      step(w, new Map());
      atFuse = Math.hypot(tank.x - mine.x, tank.y - mine.y);
    }
    assert.ok(
      atFuse > danger,
      `the tank should be clear of its own blast when the fuse runs out, but it was ` +
        `${atFuse.toFixed(2)} tiles away with the blast reaching ${danger.toFixed(2)}`,
    );
    step(w, new Map());
    assert.ok(tank.alive, 'and it should still be alive afterwards');
  }
});
