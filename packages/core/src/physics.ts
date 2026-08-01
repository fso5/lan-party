/**
 * Movement and collision.
 *
 * Two very different problems live here:
 *
 *  - Tanks need to *slide* along walls. If you drive diagonally into a wall you
 *    should keep moving along it, not stop dead. We get that by resolving each
 *    axis independently.
 *
 *  - Shells need to *reflect* exactly. A shell is a small circle moving fast
 *    through an axis-aligned grid, so we walk the grid with a DDA and reflect
 *    the velocity component belonging to whichever face we crossed. Stepping
 *    the position in fixed increments and testing for overlap -- the obvious
 *    approach -- lets fast shells tunnel through one-tile walls and produces
 *    bounce angles that depend on the step size. Neither is acceptable when the
 *    whole game is bank shots.
 */

import { Arena } from './map.js';
import { Tile } from './types.js';

/** Nudge used to keep a reflected shell off the face it just hit. */
const EPS = 1e-6;

/**
 * Move a tank, sliding along blocked tiles.
 *
 * Returns the resolved position. Axis-independent resolution is what produces
 * the slide: we try the full X move, keep it if legal, then do the same for Y.
 */
export function moveTank(
  arena: Arena,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
): { x: number; y: number } {
  let nx = x;
  let ny = y;

  if (dx !== 0 && arena.canTankOccupy(x + dx, ny, radius)) {
    nx = x + dx;
  } else if (dx !== 0) {
    // Blocked. Snap flush against the face so the tank visually touches the
    // wall instead of stopping a fraction of a tile short.
    const dir = dx > 0 ? 1 : -1;
    const edge = dir > 0 ? Math.floor(nx + radius) + 1 : Math.floor(nx - radius);
    const candidate = edge - dir * radius - dir * EPS;
    if (dir > 0 ? candidate > nx : candidate < nx) {
      if (arena.canTankOccupy(candidate, ny, radius)) nx = candidate;
    }
  }

  if (dy !== 0 && arena.canTankOccupy(nx, y + dy, radius)) {
    ny = y + dy;
  } else if (dy !== 0) {
    const dir = dy > 0 ? 1 : -1;
    const edge = dir > 0 ? Math.floor(ny + radius) + 1 : Math.floor(ny - radius);
    const candidate = edge - dir * radius - dir * EPS;
    if (dir > 0 ? candidate > ny : candidate < ny) {
      if (arena.canTankOccupy(nx, candidate, radius)) ny = candidate;
    }
  }

  return { x: nx, y: ny };
}

export interface ShellStepResult {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bouncesLeft: number;
  /** True once the shell has used its last bounce and hit another wall. */
  dead: boolean;
  /** Positions where bounces happened this step, for spark effects. */
  bounces: { x: number; y: number }[];
  /** Grid indices of destructible blocks the shell destroyed this step. */
  destroyed: number[];
}

/**
 * Advance a shell by `dist` world units, reflecting off walls.
 *
 * The circle is handled by offsetting the crossing test to the shell's leading
 * edge: contact with a vertical face happens when the *centre* is `radius` away
 * from it, so we run the DDA on (x + sign(vx)*radius) and reflect there. That
 * keeps the shell's visible edge touching the wall on every bounce.
 */
export function stepShell(
  arena: Arena,
  x: number,
  y: number,
  vx: number,
  vy: number,
  radius: number,
  bouncesLeft: number,
  dist: number,
  destroyBlocks: boolean,
): ShellStepResult {
  const bounces: { x: number; y: number }[] = [];
  const destroyed: number[] = [];
  let remaining = dist;
  let dead = false;

  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed < 1e-9) {
    return { x, y, vx, vy, bouncesLeft, dead: true, bounces, destroyed };
  }

  // Cap iterations so a shell wedged in a corner cannot spin forever.
  for (let guard = 0; guard < 64 && remaining > 1e-9; guard++) {
    const nx = vx / speed;
    const ny = vy / speed;

    // Leading edge of the circle in each axis.
    const ex = x + (nx > 0 ? radius : nx < 0 ? -radius : 0);
    const ey = y + (ny > 0 ? radius : ny < 0 ? -radius : 0);

    // Distance until the leading edge crosses the next grid line per axis.
    let tx = Infinity;
    if (nx > 0) tx = (Math.floor(ex) + 1 - ex) / nx;
    else if (nx < 0) tx = (Math.floor(ex) - ex) / nx;

    let ty = Infinity;
    if (ny > 0) ty = (Math.floor(ey) + 1 - ey) / ny;
    else if (ny < 0) ty = (Math.floor(ey) - ey) / ny;

    // A crossing exactly on a line yields t = 0; push past it so we make
    // progress instead of re-detecting the same boundary every iteration.
    if (tx <= 0) tx = nx === 0 ? Infinity : EPS;
    if (ty <= 0) ty = ny === 0 ? Infinity : EPS;

    const tHit = tx < ty ? tx : ty;

    if (tHit >= remaining) {
      // No boundary reached this step -- finish the move.
      x += nx * remaining;
      y += ny * remaining;
      remaining = 0;
      break;
    }

    // Advance to the boundary.
    x += nx * tHit;
    y += ny * tHit;
    remaining -= tHit;

    const hitVertical = tx < ty;

    // Which cell are we about to enter?
    const probeX = x + (nx > 0 ? radius + EPS : nx < 0 ? -radius - EPS : 0);
    const probeY = y + (ny > 0 ? radius + EPS : ny < 0 ? -radius - EPS : 0);
    const cellX = hitVertical ? Math.floor(probeX) : Math.floor(x);
    const cellY = hitVertical ? Math.floor(y) : Math.floor(probeY);

    const tile = arena.at(cellX, cellY);

    // Shells fly over holes and open floor.
    if (tile !== Tile.Wall && tile !== Tile.Block) continue;

    if (tile === Tile.Block && destroyBlocks) {
      // Destructible block: the shell punches through and keeps going, which
      // is what makes cork mazes collapse over the course of a match.
      arena.set(cellX, cellY, Tile.Floor);
      destroyed.push(arena.index(cellX, cellY));
      continue;
    }

    if (bouncesLeft <= 0) {
      dead = true;
      break;
    }

    bouncesLeft--;
    bounces.push({ x, y });
    if (hitVertical) {
      vx = -vx;
      x -= nx * EPS * 2; // ease off the face we just touched
    } else {
      vy = -vy;
      y -= ny * EPS * 2;
    }
    // Recompute direction from the reflected velocity on the next iteration.
    // speed is unchanged by reflection, so it stays valid.
  }

  return { x, y, vx, vy, bouncesLeft, dead, bounces, destroyed };
}

/** Circle-vs-circle overlap, used for shell/tank and blast/tank tests. */
export function circlesOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Whether a moving circle sweeps through a stationary one over a step.
 *
 * Shells move up to 0.15 units per tick while a tank is 0.76 across, so a
 * simple end-of-tick overlap test would rarely miss -- but "rarely" is not
 * never, and a shell passing cleanly through a tank is the single most
 * infuriating bug this genre can have. So we solve it properly.
 */
export function sweepCircleHit(
  px: number,
  py: number,
  dx: number,
  dy: number,
  pr: number,
  cx: number,
  cy: number,
  cr: number,
): boolean {
  // Solve |(p - c) + t*d| <= pr + cr for t in [0, 1].
  const mx = px - cx;
  const my = py - cy;
  const r = pr + cr;
  const c = mx * mx + my * my - r * r;
  if (c <= 0) return true; // already overlapping

  const a = dx * dx + dy * dy;
  if (a < 1e-12) return false; // not moving and not overlapping

  const b = mx * dx + my * dy;
  if (b >= 0) return false; // moving away

  const disc = b * b - a * c;
  if (disc < 0) return false; // never reaches

  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1;
}
