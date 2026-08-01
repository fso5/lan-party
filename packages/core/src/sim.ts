/**
 * The simulation.
 *
 * One pure function of (state, inputs) -> state, advanced at a fixed 60Hz. It
 * has no notion of rendering, time, or the network. That is deliberate and it
 * is what makes the rest of the project tractable:
 *
 *   - the host runs it authoritatively
 *   - clients run the same code to predict their own tank and to simulate
 *     shells locally from spawn events, which is what keeps us inside the
 *     Bluetooth bandwidth budget
 *   - tests run it headless, thousands of ticks a second
 *
 * The ordering inside `step` matters and is fixed: input -> turrets -> movement
 * -> spawns -> shells -> mines -> resolution. Shells move after tanks so a tank
 * cannot drive through a shell that was about to hit it.
 */

import { Arena } from './map.js';
import { Rng, datan2, dcos, dsin, rotateToward, wrapAngle } from './math.js';
import { circlesOverlap, moveTank, stepShell, sweepCircleHit } from './physics.js';
import {
  DT,
  MAX_MINES_PER_TANK,
  MAX_SHELLS_PER_TANK,
  MINE_ARM_TICKS,
  MINE_BLAST_RADIUS,
  MINE_FUSE_TICKS,
  MINE_TRIGGER_RADIUS,
  SHELL_MAX_LIFETIME_TICKS,
  TANK_RADIUS,
  TANK_SPECS,
} from './tuning.js';
import {
  EventKind,
  TankKind,
  Tile,
  emptyInput,
  type Mine,
  type Shell,
  type SimEvent,
  type Tank,
  type TankInput,
} from './types.js';
import { stepAi } from './ai.js';

export interface WorldState {
  tick: number;
  arena: Arena;
  tanks: Tank[];
  shells: Shell[];
  mines: Mine[];
  rng: Rng;
  nextEntityId: number;
  /** Cleared at the start of every step. Renderer drains it after. */
  events: SimEvent[];
}

export interface MatchConfig {
  arena: Arena;
  seed: number;
  /** Tanks to create beyond those defined by the arena's enemy list. */
  players: { team: number; spawnIndex: number }[];
}

let idCounter = 0;

function makeTank(id: number, kind: TankKind, team: number, x: number, y: number, angle: number): Tank {
  const t: Tank = {
    id,
    kind,
    team,
    alive: true,
    x,
    y,
    bodyAngle: angle,
    turretAngle: angle,
    shellsOut: 0,
    minesOut: 0,
    nextFireTick: 0,
    nextMineTick: 0,
  };
  if (kind !== TankKind.Player) {
    t.ai = {
      targetX: x,
      targetY: y,
      repathTick: 0,
      thinkTick: 0,
      focusId: -1,
      aimAngle: angle,
      aimValid: false,
    };
  }
  return t;
}

export function createWorld(cfg: MatchConfig): WorldState {
  const arena = cfg.arena.clone();
  const tanks: Tank[] = [];
  idCounter = 0;

  for (const p of cfg.players) {
    const spawn =
      arena.spawns[p.spawnIndex] ?? arena.spawns.find((s) => s.team === p.team) ?? arena.spawns[0];
    if (!spawn) throw new Error(`arena "${arena.name}" has no spawn points`);
    tanks.push(makeTank(idCounter++, TankKind.Player, p.team, spawn.x, spawn.y, spawn.angle));
  }

  for (const e of arena.enemies) {
    tanks.push(makeTank(idCounter++, e.kind as TankKind, e.team, e.x, e.y, e.angle));
  }

  return {
    tick: 0,
    arena,
    tanks,
    shells: [],
    mines: [],
    rng: new Rng(cfg.seed),
    nextEntityId: idCounter,
    events: [],
  };
}

function emit(w: WorldState, kind: EventKind, x: number, y: number, a = 0, b = 0): void {
  w.events.push({ kind, x, y, a, b });
}

export function tankById(w: WorldState, id: number): Tank | undefined {
  for (const t of w.tanks) if (t.id === id) return t;
  return undefined;
}

/** Fire a shell from a tank's turret, if it is allowed to. */
export function fireShell(w: WorldState, tank: Tank): boolean {
  const spec = TANK_SPECS[tank.kind];
  if (!tank.alive) return false;
  if (tank.shellsOut >= MAX_SHELLS_PER_TANK) return false;
  if (w.tick < tank.nextFireTick) return false;

  const dirX = dcos(tank.turretAngle);
  const dirY = dsin(tank.turretAngle);
  // Spawn at the muzzle, not the tank centre, so a shell fired against a wall
  // does not immediately reflect back into its owner.
  const muzzle = TANK_RADIUS + spec.shell.radius + 0.02;
  const sx = tank.x + dirX * muzzle;
  const sy = tank.y + dirY * muzzle;

  // If the muzzle is inside geometry, the shot is refused rather than spawning
  // a shell inside a wall.
  if (w.arena.blocksShellAt(Math.floor(sx), Math.floor(sy))) return false;

  w.shells.push({
    id: w.nextEntityId++,
    ownerId: tank.id,
    team: tank.team,
    x: sx,
    y: sy,
    vx: dirX * spec.shell.speed,
    vy: dirY * spec.shell.speed,
    radius: spec.shell.radius,
    bouncesLeft: spec.shell.maxBounces,
    bornTick: w.tick,
    selfArmDelay: spec.shell.selfArmDelay,
  });

  tank.shellsOut++;
  tank.nextFireTick = w.tick + spec.fireCooldown;
  emit(w, EventKind.ShellFired, sx, sy, tank.id);
  return true;
}

export function layMine(w: WorldState, tank: Tank): boolean {
  const spec = TANK_SPECS[tank.kind];
  if (!tank.alive || !spec.laysMines) return false;
  if (tank.minesOut >= MAX_MINES_PER_TANK) return false;
  if (w.tick < tank.nextMineTick) return false;

  w.mines.push({
    id: w.nextEntityId++,
    ownerId: tank.id,
    team: tank.team,
    x: tank.x,
    y: tank.y,
    fuseTick: w.tick + MINE_FUSE_TICKS,
    armTick: w.tick + MINE_ARM_TICKS,
  });
  tank.minesOut++;
  tank.nextMineTick = w.tick + 30;
  emit(w, EventKind.MineLaid, tank.x, tank.y, tank.id);
  return true;
}

function killTank(w: WorldState, tank: Tank, killerId: number): void {
  if (!tank.alive) return;
  tank.alive = false;
  emit(w, EventKind.TankDestroyed, tank.x, tank.y, tank.id, killerId);
}

function explodeMine(w: WorldState, mine: Mine): void {
  emit(w, EventKind.MineExploded, mine.x, mine.y, mine.ownerId);

  // Mines hurt everyone, including the tank that laid them. That is the whole
  // risk/reward of the weapon and it must apply to the player too.
  for (const t of w.tanks) {
    if (!t.alive) continue;
    if (circlesOverlap(mine.x, mine.y, MINE_BLAST_RADIUS, t.x, t.y, TANK_RADIUS)) {
      killTank(w, t, mine.ownerId);
    }
  }

  // Clear destructible blocks in the blast.
  const r = Math.ceil(MINE_BLAST_RADIUS);
  const cx = Math.floor(mine.x);
  const cy = Math.floor(mine.y);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (w.arena.at(x, y) !== Tile.Block) continue;
      // Measure to the block's centre so the blast clears a rough disc.
      const dx = x + 0.5 - mine.x;
      const dy = y + 0.5 - mine.y;
      if (dx * dx + dy * dy <= MINE_BLAST_RADIUS * MINE_BLAST_RADIUS) {
        w.arena.set(x, y, Tile.Floor);
        emit(w, EventKind.BlockDestroyed, x + 0.5, y + 0.5, w.arena.index(x, y));
      }
    }
  }

  const owner = tankById(w, mine.ownerId);
  if (owner && owner.minesOut > 0) owner.minesOut--;
}

/** Advance the world one tick. `inputs` is keyed by tank id. */
export function step(w: WorldState, inputs: Map<number, TankInput>): void {
  w.events.length = 0;

  // --- Tanks: aim, drive, act -------------------------------------------
  for (const tank of w.tanks) {
    if (!tank.alive) continue;
    const spec = TANK_SPECS[tank.kind];

    const input = tank.ai ? stepAi(w, tank) : (inputs.get(tank.id) ?? emptyInput());

    // Turret tracks toward the aim stick. A zero-length stick holds the
    // current angle, which is what lets you drive without swinging the barrel.
    const aimLen = Math.sqrt(input.aimX * input.aimX + input.aimY * input.aimY);
    if (aimLen > 0.15) {
      const desired = datan2(input.aimY, input.aimX);
      tank.turretAngle = rotateToward(tank.turretAngle, desired, spec.turretTurnRate * DT);
    }

    // Drive. The stick direction is the world direction we want to go; the
    // body rotates toward it rather than snapping, which is what gives the
    // tanks their weight.
    const moveLen = Math.sqrt(input.moveX * input.moveX + input.moveY * input.moveY);
    if (moveLen > 0.15 && spec.mobile) {
      const desired = datan2(input.moveY, input.moveX);
      tank.bodyAngle = rotateToward(tank.bodyAngle, desired, spec.bodyTurnRate * DT);

      // Speed scales with stick deflection, capped at 1, and is reduced while
      // the body is still swinging around -- tanks do not strafe.
      const throttle = moveLen > 1 ? 1 : moveLen;
      const misalign = Math.abs(wrapAngle(desired - tank.bodyAngle));
      const alignScale = misalign > 1.2 ? 0.35 : 1 - misalign * 0.35;
      const dist = spec.moveSpeed * throttle * alignScale * DT;

      const moved = moveTank(
        w.arena,
        tank.x,
        tank.y,
        dcos(tank.bodyAngle) * dist,
        dsin(tank.bodyAngle) * dist,
        TANK_RADIUS,
      );
      tank.x = moved.x;
      tank.y = moved.y;
    }

    if (input.fire) fireShell(w, tank);
    if (input.layMine) layMine(w, tank);
  }

  // --- Shells ------------------------------------------------------------
  for (let i = w.shells.length - 1; i >= 0; i--) {
    const s = w.shells[i];
    const startX = s.x;
    const startY = s.y;
    const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);

    const r = stepShell(
      w.arena,
      s.x,
      s.y,
      s.vx,
      s.vy,
      s.radius,
      s.bouncesLeft,
      speed * DT,
      true,
    );

    s.x = r.x;
    s.y = r.y;
    s.vx = r.vx;
    s.vy = r.vy;
    s.bouncesLeft = r.bouncesLeft;

    for (const b of r.bounces) emit(w, EventKind.ShellBounced, b.x, b.y, s.id);
    for (const idx of r.destroyed) {
      emit(w, EventKind.BlockDestroyed, (idx % w.arena.width) + 0.5, Math.floor(idx / w.arena.width) + 0.5, idx);
    }

    // Tank hits. Swept, so a fast shell cannot skip past a tank in one tick.
    let hitSomething = false;
    const age = w.tick - s.bornTick;
    for (const t of w.tanks) {
      if (!t.alive) continue;
      // Your own shell cannot hit you until it has cleared the muzzle. After
      // that it absolutely can, and that is the point of the game.
      if (t.id === s.ownerId && age < s.selfArmDelay) continue;

      if (sweepCircleHit(startX, startY, s.x - startX, s.y - startY, s.radius, t.x, t.y, TANK_RADIUS)) {
        killTank(w, t, s.ownerId);
        hitSomething = true;
        break;
      }
    }

    const expired = w.tick - s.bornTick > SHELL_MAX_LIFETIME_TICKS;
    if (hitSomething || r.dead || expired) {
      if (!hitSomething) emit(w, EventKind.ShellExpired, s.x, s.y, s.id);
      const owner = tankById(w, s.ownerId);
      if (owner && owner.shellsOut > 0) owner.shellsOut--;
      w.shells.splice(i, 1);
    }
  }

  // --- Mines -------------------------------------------------------------
  for (let i = w.mines.length - 1; i >= 0; i--) {
    const m = w.mines[i];
    let detonate = w.tick >= m.fuseTick;

    if (!detonate && w.tick >= m.armTick) {
      // Proximity trigger, but only for tanks that did not lay it -- otherwise
      // you could never drive away from your own mine.
      for (const t of w.tanks) {
        if (!t.alive || t.id === m.ownerId) continue;
        if (circlesOverlap(m.x, m.y, MINE_TRIGGER_RADIUS, t.x, t.y, TANK_RADIUS)) {
          detonate = true;
          break;
        }
      }
    }

    if (detonate) {
      explodeMine(w, m);
      w.mines.splice(i, 1);
    }
  }

  w.tick++;
}

/**
 * Deep copy of a world.
 *
 * Client-side reconciliation needs to rewind to the tick a snapshot describes
 * and replay its stored inputs forward, so it keeps one of these per tick in a
 * ring buffer. That is only affordable because world state is small and flat:
 * a 24x14 arena is 336 bytes of tiles, and eight tanks plus their shells add
 * well under a kilobyte. Sixty ticks of history costs ~25KB.
 *
 * This is also why entities reference each other by id rather than by object
 * reference -- there is no object graph to fix up here.
 */
export function cloneWorld(w: WorldState): WorldState {
  return {
    tick: w.tick,
    arena: w.arena.clone(),
    tanks: w.tanks.map((t) => ({ ...t, ai: t.ai ? { ...t.ai } : undefined })),
    shells: w.shells.map((s) => ({ ...s })),
    mines: w.mines.map((m) => ({ ...m })),
    rng: (() => {
      const r = new Rng(0);
      r.restore(w.rng.save());
      return r;
    })(),
    nextEntityId: w.nextEntityId,
    events: [],
  };
}

/** Teams that still have at least one living tank. */
export function livingTeams(w: WorldState): Set<number> {
  const s = new Set<number>();
  for (const t of w.tanks) if (t.alive) s.add(t.team);
  return s;
}

export function isMatchOver(w: WorldState): boolean {
  return livingTeams(w).size <= 1;
}
