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

import { Arena, type SpawnPoint } from './map.js';
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
  /** Human-controlled tanks. */
  players: { team: number; spawnIndex: number }[];
  /**
   * AI tanks beyond those the arena's ASCII already places. Versus maps ship
   * with no enemies so the same map can serve free-for-all or teams, so this is
   * how the host fills empty spawns.
   */
  bots?: { kind: number; team: number; spawnIndex: number }[];
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
      // Staggered by id rather than started at zero.
      //
      // A solve sweeps 96 angles through the real shell physics and is by far
      // the most expensive thing a tick can do. Every bot used to start at 0
      // and then re-solve every `reactionTicks`, which is per-kind -- so bots
      // of a kind stayed in lockstep for the whole match and paid for their
      // solves on the same tick, forever. That is why the cost is spiky rather
      // than steady: with eight bots the median tick costs 9us and the 99th
      // costs 2095us, and it is the spike that drops a frame, not the median.
      //
      // Offsetting by id spreads the same work across ticks. It changes when a
      // bot first thinks, never what it decides, and it stays deterministic --
      // ids come from creation order, which is already part of the wire
      // contract, so a client rebuilding the roster gets the same offsets.
      thinkTick: id % TANK_SPECS[kind].reactionTicks,
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

  /*
   * A spawn index the map does not have lands somewhere free, not on somebody.
   *
   * The last resort here used to be `arena.spawns[0]`, and that is a silent
   * wrong answer: it puts the new tank on top of whoever already had the first
   * corner -- two tanks on one square, indistinguishable on screen, killed by
   * the same shell, and nothing pushes them apart because tanks do not collide
   * with each other.
   *
   * Both hosts reached it. The Bluetooth one indexed spawns by a count of
   * players while bots held the other spawns; the WiFi one seated every
   * connected browser, so the ninth on an eight-spawn map asked for index 8.
   * Both are fixed, and both were caller bugs -- but a shared function that
   * answers a bad index with a bad world is how a caller bug becomes an
   * invisible one, twice.
   *
   * Not a throw. A client builds its world from a roster the host sent, so
   * throwing hands any host the power to kill every client's match; landing
   * somewhere free degrades instead. Deterministic either way, which is what
   * matters most: host and client run this same function over the same roster
   * in the same order, so they make the same choice.
   */
  const placeAt = (index: number, team: number): SpawnPoint => {
    const exact = arena.spawns[index];
    if (exact) return exact;
    const byTeam = arena.spawns.find((s) => s.team === team);
    if (byTeam) return byTeam;
    const free = freeSpawnIndex(arena.spawns, tanks);
    // Every spawn occupied is a roster larger than the map. Nothing left to do
    // but stack, and the caller has already been told off by then.
    return arena.spawns[free] ?? arena.spawns[0];
  };

  for (const p of cfg.players) {
    const spawn = placeAt(p.spawnIndex, p.team);
    if (!spawn) throw new Error(`arena "${arena.name}" has no spawn points`);
    tanks.push(makeTank(idCounter++, TankKind.Player, p.team, spawn.x, spawn.y, spawn.angle));
  }

  // Creation order is part of the wire contract: tank ids come from position,
  // so host and client must build the roster in exactly this order -- players,
  // then the arena's own enemies, then explicitly configured bots. A client
  // that reorders these gets correct tanks under the wrong ids, and every
  // snapshot afterwards silently applies to the wrong one.
  for (const e of arena.enemies) {
    tanks.push(makeTank(idCounter++, e.kind as TankKind, e.team, e.x, e.y, e.angle));
  }

  for (const b of cfg.bots ?? []) {
    // Same rule as the players above. Bots have no team spawn to fall back on
    // -- versus maps put teams on the map, not on the roster -- so an unusable
    // index goes straight to the first free start.
    const spawn = placeAt(b.spawnIndex, b.team);
    if (!spawn) throw new Error(`arena "${arena.name}" has no spawn points`);
    tanks.push(makeTank(idCounter++, b.kind as TankKind, b.team, spawn.x, spawn.y, spawn.angle));
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

/**
 * Destroy a tank and record it.
 *
 * Exported because the host has one reason to kill a tank that no shell or
 * mine accounts for: a player who left. Going through here rather than setting
 * `alive = false` directly is what puts a `TankDestroyed` event in the world,
 * which is how every client learns about it and how the explosion gets drawn.
 */
export function killTank(w: WorldState, tank: Tank, killerId: number): void {
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

/**
 * Advance the world one tick. `inputs` is keyed by tank id.
 *
 * `spawnsFor` names the one tank allowed to create shells and mines. Omit it
 * on the host, where every tank may.
 *
 * A client must pass its own tank, because entity creation is the one part of
 * the simulation it cannot be allowed to predict for anybody else. The host
 * sends a spawn for every shell fired in the match, including the bots' -- and
 * the client is also running those same bots locally, so without this it ends
 * up holding two of each: the one it invented and the one it was told about,
 * with different ids, at slightly different places. Ten seconds of a
 * bots-and-two-players match had the client drawing eleven more shells than
 * existed on the host.
 *
 * Movement is still predicted for everyone -- that is what keeps the other
 * tanks smooth between snapshots, and a snapshot corrects it fifteen times a
 * second. Nothing corrects an invented shell.
 */
export function step(w: WorldState, inputs: Map<number, TankInput>, spawnsFor?: number): void {
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

    const maySpawn = spawnsFor === undefined || tank.id === spawnsFor;
    if (input.fire && maySpawn) fireShell(w, tank);
    if (input.layMine && maySpawn) layMine(w, tank);
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

/**
 * A spawn point with nobody standing on it, or -1 if there is none.
 *
 * For seating a player into a match that is already running. The obvious
 * version of this counts something and uses the count as an index, and that is
 * what shipped in the Bluetooth host: it counted *players* and indexed the
 * spawn array with the result. Bots are not players, so with the host at spawn
 * 0 and three bots on spawns 1-3, the first person to join was handed spawn 1
 * and materialised on top of a bot -- measured on all three versus maps. The
 * cap in front of it compared the same player count against the spawn count,
 * so it never fired either.
 *
 * Asking what is *occupied* rather than counting anything gets all of that
 * right at once, and one case a fixed index cannot: tanks move. A spawn whose
 * original occupant has driven away is free, and a dead tank does not hold a
 * spawn at all.
 *
 * Occupied means "a living tank is close enough to overlap": two tank radii,
 * which is the distance at which two bodies touch. Tanks do not collide with
 * each other, so a spawn judged free by a smaller margin would still produce
 * two tanks sharing one square -- indistinguishable on screen and killed by the
 * same shell.
 */
export function freeSpawnIndex(spawns: readonly SpawnPoint[], tanks: readonly Tank[]): number {
  return spawns.findIndex(
    (s) =>
      !tanks.some((t) => {
        if (!t.alive) return false;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        return dx * dx + dy * dy < (TANK_RADIUS * 2) * (TANK_RADIUS * 2);
      }),
  );
}
