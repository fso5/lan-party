/**
 * Core simulation types.
 *
 * Everything in the world state is plain data with no methods and no object
 * references between entities -- entities point at each other by id only. That
 * keeps the whole state trivially serializable for netcode snapshots, replays,
 * and rollback, and it means structuredClone-free deep copies are cheap.
 */

/** Tile kinds in the arena grid. */
export enum Tile {
  /** Open floor. Tanks and shells pass freely. */
  Floor = 0,
  /** Indestructible wall. Blocks tanks; shells ricochet. */
  Wall = 1,
  /** Destructible block ("cork"). Blocks tanks and shells until destroyed. */
  Block = 2,
  /** Hole in the floor. Tanks cannot enter; shells fly over. */
  Hole = 3,
}

export function blocksTank(t: Tile): boolean {
  return t === Tile.Wall || t === Tile.Block || t === Tile.Hole;
}

export function blocksShell(t: Tile): boolean {
  // Shells fly over holes -- this is what makes hole maps play differently.
  return t === Tile.Wall || t === Tile.Block;
}

/** Which side an entity fights for. 0 is always the human/player team. */
export type TeamId = number;

/**
 * Enemy archetypes from the original, plus the human-controlled tank.
 *
 * Each type is a bundle of movement speed, turret tracking rate, shell profile,
 * aim error, fire cadence, and mine behaviour. The values live in tuning.ts so
 * they can be rebalanced without touching AI code.
 */
export enum TankKind {
  Player = 0,
  /** Stationary, slow turret, no lead, single-bounce shells. The tutorial enemy. */
  Brown = 1,
  /** Slow roamer, fires ricochet shots, will bank shots off walls. */
  Grey = 2,
  /** Fast, fires quick rockets that do not bounce. Pressures you constantly. */
  Teal = 3,
  /** Roams and lays mines behind it. Area denial. */
  Yellow = 4,
  /** Immobile turret with precise two-bounce shots. Punishes standing still. */
  Green = 5,
  /** Aggressive, fast rockets, actively closes distance. Late-game threat. */
  Black = 6,
}

/** How a shell behaves once fired. */
export interface ShellProfile {
  speed: number;
  /** Number of wall bounces before the shell dies. 0 = rocket. */
  maxBounces: number;
  radius: number;
  /** Ticks before the shell can harm the tank that fired it. */
  selfArmDelay: number;
}

export interface Tank {
  id: number;
  kind: TankKind;
  team: TeamId;
  alive: boolean;
  x: number;
  y: number;
  /** Body facing, radians. Drives movement direction. */
  bodyAngle: number;
  /** Turret facing, radians. Independent of the body -- this is what fires. */
  turretAngle: number;
  /** Shells currently in flight belonging to this tank. Capped per tuning. */
  shellsOut: number;
  minesOut: number;
  /** Tick index when this tank may fire again. */
  nextFireTick: number;
  nextMineTick: number;
  /** Per-tank AI scratch state. Absent for the player. */
  ai?: AiState;
}

export interface AiState {
  /** Where the AI is currently trying to drive to. */
  targetX: number;
  targetY: number;
  /** Tick at which it will pick a new wander target. */
  repathTick: number;
  /** Tick at which it will next consider taking a shot. */
  thinkTick: number;
  /** Id of the tank it is currently aiming at, or -1. */
  focusId: number;
  /** Cached firing solution, recomputed on think ticks. */
  aimAngle: number;
  aimValid: boolean;
}

export interface Shell {
  id: number;
  ownerId: number;
  team: TeamId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  bouncesLeft: number;
  /** Tick this shell was fired -- used for the self-arm grace period. */
  bornTick: number;
  selfArmDelay: number;
}

export interface Mine {
  id: number;
  ownerId: number;
  team: TeamId;
  x: number;
  y: number;
  /** Tick at which it detonates on its own. */
  fuseTick: number;
  /** Tick after which a passing enemy can trigger it early. */
  armTick: number;
}

/** Transient visual/audio cues the renderer consumes and discards each tick. */
export enum EventKind {
  ShellFired = 0,
  ShellBounced = 1,
  ShellExpired = 2,
  MineLaid = 3,
  MineExploded = 4,
  BlockDestroyed = 5,
  TankDestroyed = 6,
}

export interface SimEvent {
  kind: EventKind;
  x: number;
  y: number;
  /** Meaning depends on kind: tank id, shell id, or destroyed tile index. */
  a: number;
  b: number;
}

/** Per-tick control input for one tank. Also the exact wire format for netcode. */
export interface TankInput {
  /** Drive stick, each axis in [-1, 1]. */
  moveX: number;
  moveY: number;
  /** Aim stick, each axis in [-1, 1]. Zero length means "hold current aim". */
  aimX: number;
  aimY: number;
  fire: boolean;
  layMine: boolean;
}

export function emptyInput(): TankInput {
  return { moveX: 0, moveY: 0, aimX: 0, aimY: 0, fire: false, layMine: false };
}
