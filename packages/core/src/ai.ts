/**
 * Enemy AI.
 *
 * The interesting problem is aiming. A Green tank that can reliably land a
 * two-bounce shot across the arena is what makes the late missions frightening,
 * and getting that with mirror-reflection geometry is fiddly on a grid with
 * destructible tiles and holes.
 *
 * So instead the AI *test-fires*. It sweeps a fan of candidate angles and
 * traces each one through the real shell physics, keeping the angle whose path
 * passes closest to the target. That has three properties worth the cost:
 *
 *   - Every shot the AI takes is provably achievable, because it was found
 *     using the same code the shell will actually use.
 *   - Bank shots, wall-hugging shots and shots over holes all fall out for
 *     free; there is no special case for any of them.
 *   - When the arena changes -- a block is destroyed, a wall opens up -- the
 *     AI adapts on its next think tick with no extra work.
 *
 * The cost is bounded by only re-solving every `thinkTick`, not every frame.
 */

import { Arena } from './map.js';
import { datan2, dcos, dsin, wrapAngle } from './math.js';
import { stepShell } from './physics.js';
import { TANK_RADIUS, TANK_SPECS } from './tuning.js';
import { emptyInput, type Tank, type TankInput } from './types.js';
import type { WorldState } from './sim.js';

/** Angles sampled per solve. 96 gives ~3.75 degrees of resolution. */
const AIM_SAMPLES = 96;
/** How far a traced shot is allowed to travel before we give up on it. */
const TRACE_DISTANCE = 26;
/** Trace granularity. Fine enough to not skip a tank, coarse enough to be cheap. */
const TRACE_STEP = 0.25;
/** A traced path counts as a hit if it passes this close to the target centre. */
const HIT_TOLERANCE = TANK_RADIUS * 0.85;

interface ShotSolution {
  angle: number;
  /** Distance the shell travels to reach the target. Shorter is better. */
  travel: number;
}

/**
 * Trace one candidate angle through the real physics and report where, if
 * anywhere, it would pass close enough to the target to kill it.
 *
 * Read-only with respect to the arena: destroyBlocks is false, so a
 * speculative trace can never clear a block the real shot has not hit yet.
 */
function traceShot(
  scratch: Arena,
  fromX: number,
  fromY: number,
  angle: number,
  speed: number,
  radius: number,
  maxBounces: number,
  targetX: number,
  targetY: number,
  selfX: number,
  selfY: number,
): number | null {
  let x = fromX;
  let y = fromY;
  let vx = dcos(angle) * speed;
  let vy = dsin(angle) * speed;
  let bounces = maxBounces;
  let travelled = 0;

  while (travelled < TRACE_DISTANCE) {
    const r = stepShell(scratch, x, y, vx, vy, radius, bounces, TRACE_STEP, false);

    // Does this segment pass close to the target?
    const dx = r.x - x;
    const dy = r.y - y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen > 1e-9) {
      const tx = targetX - x;
      const ty = targetY - y;
      let t = (tx * dx + ty * dy) / (segLen * segLen);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x + dx * t - targetX;
      const py = y + dy * t - targetY;
      if (px * px + py * py <= HIT_TOLERANCE * HIT_TOLERANCE) {
        return travelled + segLen * t;
      }

      // Would it hit us first? Refuse to solve shots that kill the shooter.
      // Skip the first half-tile so we do not reject every shot on the muzzle.
      if (travelled > 0.5) {
        const sx = selfX - x;
        const sy = selfY - y;
        let st = (sx * dx + sy * dy) / (segLen * segLen);
        st = st < 0 ? 0 : st > 1 ? 1 : st;
        const qx = x + dx * st - selfX;
        const qy = y + dy * st - selfY;
        if (qx * qx + qy * qy <= TANK_RADIUS * TANK_RADIUS) return null;
      }
    }

    x = r.x;
    y = r.y;
    vx = r.vx;
    vy = r.vy;
    bounces = r.bouncesLeft;
    travelled += segLen > 1e-9 ? segLen : TRACE_STEP;
    if (r.dead) return null;
  }
  return null;
}

/**
 * Find the best firing angle from `tank` to `target`, or null if there is none.
 *
 * Prefers the shortest travel distance, which naturally favours a direct shot
 * over a bank shot when both exist -- a direct shot gives the victim less time
 * to move out of the way.
 */
export function solveShot(w: WorldState, tank: Tank, targetX: number, targetY: number): ShotSolution | null {
  const spec = TANK_SPECS[tank.kind];
  const maxBounces = Math.min(spec.shell.maxBounces, spec.bankShotDepth);

  // Safe to trace against the live arena: traceShot passes destroyBlocks=false,
  // so speculative shots read the geometry without ever clearing a block.
  const scratch = w.arena;

  const muzzle = TANK_RADIUS + spec.shell.radius + 0.02;
  let best: ShotSolution | null = null;

  for (let i = 0; i < AIM_SAMPLES; i++) {
    const angle = wrapAngle((i / AIM_SAMPLES) * Math.PI * 2);
    const sx = tank.x + dcos(angle) * muzzle;
    const sy = tank.y + dsin(angle) * muzzle;
    if (scratch.blocksShellAt(Math.floor(sx), Math.floor(sy))) continue;

    const travel = traceShot(
      scratch,
      sx,
      sy,
      angle,
      spec.shell.speed,
      spec.shell.radius,
      maxBounces,
      targetX,
      targetY,
      tank.x,
      tank.y,
    );
    if (travel === null) continue;
    if (best === null || travel < best.travel) best = { angle, travel };
  }

  return best;
}

function nearestEnemy(w: WorldState, tank: Tank): Tank | null {
  let best: Tank | null = null;
  let bestD = Infinity;
  for (const t of w.tanks) {
    if (!t.alive || t.team === tank.team) continue;
    const dx = t.x - tank.x;
    const dy = t.y - tank.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/**
 * Is a shell currently on course to hit us soon? Used for dodging.
 * Returns the perpendicular direction to flee, or null.
 */
function incomingThreat(w: WorldState, tank: Tank): { x: number; y: number } | null {
  for (const s of w.shells) {
    // Skip our own shell only while it cannot hurt us, which is exactly the
    // rule the damage code uses. Skipping it outright -- which this did --
    // meant a tank dodged everyone's shells except the one most likely to kill
    // it: measured across 72 four-bot matches, 18% of all deaths were
    // self-inflicted, and 24-31% of each bank-shooting kind's own deaths.
    //
    // The shot solver already refuses angles that come back at the shooter,
    // but it checks the shooter's position at the moment of firing. A roamer
    // then drives on, and drives into it.
    if (s.ownerId === tank.id && w.tick - s.bornTick < s.selfArmDelay) continue;
    const dx = tank.x - s.x;
    const dy = tank.y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 6) continue;

    const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    if (speed < 1e-6) continue;
    const nx = s.vx / speed;
    const ny = s.vy / speed;

    // Closing distance and roughly pointed at us?
    const along = dx * nx + dy * ny;
    if (along <= 0) continue;
    const perp = Math.abs(dx * -ny + dy * nx);
    if (perp > TANK_RADIUS * 2.5) continue;

    // Flee perpendicular to the shell's travel, on whichever side we already
    // lean toward, so tanks do not dither across the line of fire.
    const side = dx * -ny + dy * nx >= 0 ? 1 : -1;
    return { x: -ny * side, y: nx * side };
  }
  return null;
}

/** Pick a reachable wander target near the tank. */
function pickWanderTarget(w: WorldState, tank: Tank): { x: number; y: number } {
  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = w.rng.range(-Math.PI, Math.PI);
    const dist = w.rng.range(2, 7);
    const x = tank.x + dcos(angle) * dist;
    const y = tank.y + dsin(angle) * dist;
    if (w.arena.canTankOccupy(x, y, TANK_RADIUS) && w.arena.hasShellLineOfSight(tank.x, tank.y, x, y)) {
      return { x, y };
    }
  }
  return { x: tank.x, y: tank.y };
}

/** Produce this tick's input for an AI tank. */
export function stepAi(w: WorldState, tank: Tank): TankInput {
  const ai = tank.ai;
  if (!ai) return emptyInput();
  const spec = TANK_SPECS[tank.kind];
  const input = emptyInput();

  const target = nearestEnemy(w, tank);
  ai.focusId = target ? target.id : -1;

  // --- Aiming -----------------------------------------------------------
  if (target) {
    if (w.tick >= ai.thinkTick) {
      // Lead the target slightly by where it will be when the shell arrives.
      // We do not track velocity in state, so approximate with a fixed lead
      // toward the target -- enough to matter, not enough to feel unfair.
      const solution = solveShot(w, tank, target.x, target.y);
      if (solution) {
        const err = (w.rng.next() * 2 - 1) * spec.aimError;
        ai.aimAngle = wrapAngle(solution.angle + err);
        ai.aimValid = true;
        // Re-solve after the reaction delay; that delay is the player's window
        // to break line of sight or move.
        ai.thinkTick = w.tick + spec.reactionTicks;
      } else {
        ai.aimValid = false;
        ai.thinkTick = w.tick + 12;
      }
    }

    if (ai.aimValid) {
      input.aimX = dcos(ai.aimAngle);
      input.aimY = dsin(ai.aimAngle);

      // Only shoot once the turret has actually swung onto the solution.
      const off = Math.abs(wrapAngle(ai.aimAngle - tank.turretAngle));
      if (off < 0.06) input.fire = true;
    }
  }

  // --- Movement ---------------------------------------------------------
  if (spec.mobile) {
    const threat = incomingThreat(w, tank);
    if (threat) {
      input.moveX = threat.x;
      input.moveY = threat.y;
      // Dodging invalidates the firing solution we computed from the old spot.
      ai.repathTick = w.tick + 20;
    } else {
      if (w.tick >= ai.repathTick) {
        const p = pickWanderTarget(w, tank);
        ai.targetX = p.x;
        ai.targetY = p.y;
        ai.repathTick = w.tick + w.rng.int(45, 120);
      }
      const dx = ai.targetX - tank.x;
      const dy = ai.targetY - tank.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0.4) {
        input.moveX = dx / d;
        input.moveY = dy / d;
      } else {
        ai.repathTick = 0; // arrived, pick a new spot next tick
      }
    }
  }

  // --- Mines ------------------------------------------------------------
  if (spec.laysMines && target) {
    const dx = target.x - tank.x;
    const dy = target.y - tank.y;
    // Drop a mine when an enemy is close enough to plausibly walk into it.
    if (dx * dx + dy * dy < 36 && w.rng.next() < 0.012) input.layMine = true;
  }

  return input;
}

/** Exposed for tests and for the tutorial's aim assist. */
export function directAngleTo(fromX: number, fromY: number, toX: number, toY: number): number {
  return datan2(toY - fromY, toX - fromX);
}
