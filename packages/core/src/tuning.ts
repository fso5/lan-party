/**
 * Gameplay constants.
 *
 * All distances are in world units where one tile is exactly 1.0, and all rates
 * are per-tick at TICK_HZ. Keeping everything tile-relative means maps can be
 * authored on a grid and tanks feel identical regardless of arena size.
 *
 * These numbers are the tuning surface for the whole game -- the AI and physics
 * code reads them and never hardcodes its own.
 */

import { TankKind, type ShellProfile } from './types.js';

/** Simulation rate. Fixed forever: netcode and replays assume it. */
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

/** Tank body radius. Slightly under half a tile so gaps of 1 tile are passable. */
export const TANK_RADIUS = 0.38;

/** How many shells and mines one tank may have live at once. */
export const MAX_SHELLS_PER_TANK = 5;
export const MAX_MINES_PER_TANK = 2;

/** Mine timing. */
export const MINE_FUSE_TICKS = 300; // 5s until it blows on its own
export const MINE_ARM_TICKS = 45; // 0.75s before it can be triggered by proximity
export const MINE_TRIGGER_RADIUS = 0.9;
export const MINE_BLAST_RADIUS = 1.6;

/** A shell that has bounced its last still needs to die somewhere. */
export const SHELL_MAX_LIFETIME_TICKS = 60 * 12;

/**
 * Tanks in a good match, and the number bots are filled up to.
 *
 * Separate from `arena.spawns.length` on purpose, and the separation is the
 * whole point of the constant. Filling every unused spawn with a bot reads as
 * reasonable until the maps gain spawns for a fuller lobby: they went from four
 * starts to eight, and every solo game silently became one against seven.
 * How many places a map has is a question about the map. How many opponents
 * make a good fight is a question about the game, and this is that answer.
 *
 * The join cap stays on `spawns.length` -- that one really is "how many people
 * can this map hold".
 */
export const DEFAULT_MATCH_SIZE = 4;

export interface TankSpec {
  /** World units per second. */
  moveSpeed: number;
  /** Radians per second the body turns to face the drive direction. */
  bodyTurnRate: number;
  /** Radians per second the turret tracks toward its aim target. */
  turretTurnRate: number;
  shell: ShellProfile;
  /** Ticks between shots. */
  fireCooldown: number;
  /** Standard deviation of aim error in radians. Player is always 0. */
  aimError: number;
  /**
   * How long the AI deliberates before firing once it has a solution, in ticks.
   * This is the single most important "fairness" knob -- it is what gives you
   * time to dodge, and what makes late-game tanks terrifying.
   */
  reactionTicks: number;
  /** Whether this type drives at all. */
  mobile: boolean;
  /** Whether this type lays mines. */
  laysMines: boolean;
  /** Max wall bounces the AI will consider when looking for a bank shot. */
  bankShotDepth: number;
}

const ROCKET: ShellProfile = { speed: 9.0, maxBounces: 0, radius: 0.11, selfArmDelay: 6 };
const NORMAL: ShellProfile = { speed: 5.5, maxBounces: 1, radius: 0.12, selfArmDelay: 8 };
const RICOCHET: ShellProfile = { speed: 5.0, maxBounces: 2, radius: 0.12, selfArmDelay: 10 };

export const TANK_SPECS: Record<TankKind, TankSpec> = {
  [TankKind.Player]: {
    moveSpeed: 3.2,
    bodyTurnRate: 7.0,
    turretTurnRate: 9.0,
    shell: NORMAL,
    fireCooldown: 12,
    aimError: 0,
    reactionTicks: 0,
    mobile: true,
    laysMines: true,
    bankShotDepth: 0,
  },
  [TankKind.Brown]: {
    moveSpeed: 0,
    bodyTurnRate: 0,
    turretTurnRate: 1.1,
    shell: NORMAL,
    fireCooldown: 100,
    aimError: 0.09,
    reactionTicks: 55,
    mobile: false,
    laysMines: false,
    bankShotDepth: 0,
  },
  [TankKind.Grey]: {
    moveSpeed: 1.5,
    bodyTurnRate: 3.0,
    turretTurnRate: 2.2,
    shell: RICOCHET,
    fireCooldown: 80,
    aimError: 0.05,
    reactionTicks: 40,
    mobile: true,
    laysMines: false,
    bankShotDepth: 2,
  },
  [TankKind.Teal]: {
    moveSpeed: 2.6,
    bodyTurnRate: 5.0,
    turretTurnRate: 3.4,
    shell: ROCKET,
    fireCooldown: 55,
    aimError: 0.04,
    reactionTicks: 26,
    mobile: true,
    laysMines: false,
    bankShotDepth: 0,
  },
  [TankKind.Yellow]: {
    moveSpeed: 2.0,
    bodyTurnRate: 4.0,
    turretTurnRate: 2.6,
    shell: NORMAL,
    fireCooldown: 70,
    aimError: 0.06,
    reactionTicks: 34,
    mobile: true,
    laysMines: true,
    bankShotDepth: 1,
  },
  [TankKind.Green]: {
    moveSpeed: 0,
    bodyTurnRate: 0,
    turretTurnRate: 1.8,
    shell: RICOCHET,
    fireCooldown: 90,
    aimError: 0.012, // near-perfect: this is the sniper
    reactionTicks: 30,
    mobile: false,
    laysMines: false,
    bankShotDepth: 2,
  },
  [TankKind.Black]: {
    moveSpeed: 3.4,
    bodyTurnRate: 6.0,
    turretTurnRate: 4.2,
    shell: ROCKET,
    fireCooldown: 40,
    aimError: 0.03,
    reactionTicks: 18,
    mobile: true,
    laysMines: true,
    bankShotDepth: 1,
  },
};
