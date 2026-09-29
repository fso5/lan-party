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

/**
 * How many shells and mines the player may have live at once.
 *
 * Each tank type has its own limits (`maxShells`, `maxMines` in its spec),
 * following the original game; these are the player's, and the most any type
 * has except the yellow tank's four mines.
 */
export const MAX_SHELLS_PER_TANK = 5;
export const MAX_MINES_PER_TANK = 2;

/** Mine timing. */
export const MINE_FUSE_TICKS = 600; // 10s until it blows on its own, as in the original
export const MINE_ARM_TICKS = 45; // 0.75s before it can be triggered by proximity
export const MINE_TRIGGER_RADIUS = 0.9;
export const MINE_BLAST_RADIUS = 1.6;
/**
 * A mine's body, for shells: a shell touching this sets it off. The size the
 * page draws it at (game.js reads this rather than its own copy).
 */
export const MINE_RADIUS = 0.22;

/**
 * How close two shells' centres must pass to destroy each other, in tiles.
 *
 * Wider than their bodies (0.24 together), on purpose. A shell is drawn a
 * little larger than it is and trails a streak, so at the bare body size two
 * shells could be seen to overlap and fly on. Shooting a shell down is a
 * skill the game rewards; the reach is set so that anything that looks like a
 * touch is one. Shells against tanks, walls and mines keep their real size.
 */
export const SHELL_INTERCEPT_REACH = 0.4;

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
   * How long a bot sticks with a firing solution before working out a new one.
   *
   * The single most important "fairness" knob, but not for the reason this
   * comment used to give. It said the bot deliberates this long *before
   * firing*, and it does not: a bot whose turret already points at its solution
   * fires within two ticks whatever this is set to -- measured at 55, 40 and 26
   * with identical results. Firing is gated by the turret swinging onto the
   * solution and by fireCooldown, not by this.
   *
   * What it gates is re-solving. Between solutions the bot keeps aiming where
   * it worked out, so a target that moves gets shot at where it used to be.
   * That is the window to dodge, and a shorter one really does make late-game
   * tanks terrifying -- by way of tracking you, not by way of reacting faster.
   */
  reactionTicks: number;
  /** Whether this type drives at all. */
  mobile: boolean;
  /** Whether this type lays mines. */
  laysMines: boolean;
  /** Most shells this type may have in flight at once. */
  maxShells: number;
  /** Most mines this type may have down at once. */
  maxMines: number;
  /** Max wall bounces the AI will consider when looking for a bank shot. */
  bankShotDepth: number;
}

/*
 * Speeds and reloads follow the original game, by way of TanksRebirth
 * (github.com/RighteousRyan1/TanksRebirth), a remake that sets out to match
 * it. It runs at 60 frames a second like this sim, so its reloads are ticks
 * here as they stand; its speeds convert at 21.7 units to a block -- shells
 * move 0.62 x speed units a frame and tanks 0.55 x speed. Rockets come out at
 * twice a normal shell, which is also how the original's players describe
 * them. These are a remake's numbers, not ones read out of the original.
 */
const ROCKET: ShellProfile = { speed: 10.3, maxBounces: 0, radius: 0.11, selfArmDelay: 6 };
const NORMAL: ShellProfile = { speed: 5.1, maxBounces: 1, radius: 0.12, selfArmDelay: 8 };
/** The green sniper's: rocket-fast, and bounces twice. */
const SNIPER: ShellProfile = { speed: 10.3, maxBounces: 2, radius: 0.12, selfArmDelay: 10 };

export const TANK_SPECS: Record<TankKind, TankSpec> = {
  [TankKind.Player]: {
    moveSpeed: 2.7,
    bodyTurnRate: 7.0,
    turretTurnRate: 9.0,
    shell: NORMAL,
    fireCooldown: 5,
    aimError: 0,
    reactionTicks: 0,
    mobile: true,
    laysMines: true,
    maxShells: MAX_SHELLS_PER_TANK,
    maxMines: MAX_MINES_PER_TANK,
    bankShotDepth: 0,
  },
  [TankKind.Brown]: {
    moveSpeed: 0,
    bodyTurnRate: 0,
    turretTurnRate: 1.1,
    shell: NORMAL,
    fireCooldown: 300,
    aimError: 0.09,
    reactionTicks: 55,
    mobile: false,
    laysMines: false,
    maxShells: 1,
    maxMines: 0,
    bankShotDepth: 0,
  },
  [TankKind.Grey]: {
    moveSpeed: 1.8,
    bodyTurnRate: 3.0,
    turretTurnRate: 2.2,
    shell: NORMAL, // one bounce, as in the original
    fireCooldown: 180,
    aimError: 0.05,
    reactionTicks: 40,
    mobile: true,
    laysMines: false,
    maxShells: 1,
    maxMines: 0,
    bankShotDepth: 1,
  },
  [TankKind.Teal]: {
    moveSpeed: 1.5,
    bodyTurnRate: 5.0,
    turretTurnRate: 3.4,
    shell: ROCKET,
    fireCooldown: 180,
    aimError: 0.04,
    reactionTicks: 26,
    mobile: true,
    laysMines: false,
    maxShells: 1,
    maxMines: 0,
    bankShotDepth: 0,
  },
  [TankKind.Yellow]: {
    moveSpeed: 2.7,
    bodyTurnRate: 4.0,
    turretTurnRate: 2.6,
    shell: NORMAL,
    fireCooldown: 180,
    aimError: 0.06,
    reactionTicks: 34,
    mobile: true,
    laysMines: true,
    maxShells: 1,
    maxMines: 4,
    bankShotDepth: 1,
  },
  [TankKind.Green]: {
    moveSpeed: 0,
    bodyTurnRate: 0,
    turretTurnRate: 1.8,
    shell: SNIPER,
    fireCooldown: 60,
    aimError: 0.012, // near-perfect: this is the sniper
    reactionTicks: 30,
    mobile: false,
    laysMines: false,
    maxShells: 2,
    maxMines: 0,
    bankShotDepth: 2,
  },
  [TankKind.Black]: {
    moveSpeed: 3.6,
    bodyTurnRate: 6.0,
    turretTurnRate: 4.2,
    shell: ROCKET,
    fireCooldown: 60,
    aimError: 0.03,
    reactionTicks: 18,
    mobile: true,
    laysMines: true,
    maxShells: 2,
    maxMines: 2,
    bankShotDepth: 1,
  },
};

/**
 * The kinds a versus map is filled up with when there are spare spawns.
 *
 * Here rather than in each caller because it was written out in four places
 * and drifted: a measured fix reached two of them and left the solo path and
 * the app's host still fielding a tank that cannot move.
 *
 * No immobile kind, which is measured rather than assumed. It used to read
 * [Grey, Teal, Green], and Green has `moveSpeed: 0` -- over 96 seeds on each of
 * the three versus maps it won 0-2% of rounds and stayed alive for 2.8-2.9
 * seconds. Brown, the other turret, is identical. A free-for-all points three
 * shooters at a tank that cannot leave its corner, so a third of the opposition
 * was gone before the opening exchange finished. Yellow, in its place, wins
 * 8-18% and lives 8-13 seconds.
 *
 * Not a verdict on Green as a kind, and the campaign is why this is scoped to
 * versus: there both turrets sit on a team facing a single player, which is the
 * fight they are built for. See tools/campaign-curve.mjs.
 *
 * ## Re-measuring this needs the lineup it was measured against
 *
 * The numbers above do not say who the other three tanks were, and that is
 * enough to make them unreproducible. Checked by trying: a four-tank
 * free-for-all against Grey, Teal and Black, 96 seeds on each versus map, puts
 * Green at 0% and a 1.5s median life and Yellow at 6-14% and 2.9-7.3s. The
 * conclusion is the same one -- an immobile kind contributes nothing to a
 * versus fill and Yellow plainly does -- but the lifetimes are about half those
 * recorded, and there is no way to tell from here whether the game changed or
 * the opposition did.
 *
 * So: opponents decide survival time as much as the kind under test does. Any
 * re-measurement that wants to compare against the figures above has to fix
 * the lineup first and say what it was. The ranking is what this constant
 * rests on, and that has been re-confirmed; the seconds are context, not a
 * threshold anything checks.
 */
export const VERSUS_BOT_KINDS: readonly TankKind[] = [TankKind.Grey, TankKind.Teal, TankKind.Yellow];
