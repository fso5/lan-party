/**
 * The campaign: the original game's progression, and the missions it is
 * played on.
 *
 * ## Rules, as the original has them
 *
 * A run starts with three lives and earns one more for every five missions
 * cleared. The first run is twenty missions; clearing mission twenty for the
 * first time ends it with "Mission Completed", and from then on a run goes on
 * to mission one hundred. Losing your last life ends the run.
 *
 * ## Missions
 *
 * One to five are the hand-made maps in maps/index.ts. Six to one hundred come
 * from `generateMission`, seeded by the mission number, so a mission is the
 * same on every phone and in every run. The original's own layouts are not
 * reproduced: they are its content, not its rules. What is kept is its shape --
 * a 22x17 field, tanks brought in one kind at a time in roughly its order, and
 * more of them as the missions go on, about 540 across the hundred.
 */

import { Rng } from './math.js';
import { MISSIONS, missionById, type Mission } from './maps/index.js';
import { TankKind } from './types.js';

export const FIRST_RUN_MISSIONS = 20;
export const CAMPAIGN_MISSIONS = 100;
export const START_LIVES = 3;
export const BONUS_LIFE_EVERY = 5;

export interface CampaignRun {
  /** The mission being played, from 1. */
  mission: number;
  lives: number;
  /** Where this run ends: 20 until mission 20 has been cleared once, then 100. */
  length: number;
}

export function startRun(hundredUnlocked: boolean): CampaignRun {
  return {
    mission: 1,
    lives: START_LIVES,
    length: hundredUnlocked ? CAMPAIGN_MISSIONS : FIRST_RUN_MISSIONS,
  };
}

export interface ClearResult {
  run: CampaignRun;
  /** A life was earned for this clear. */
  bonusLife: boolean;
  /** That was the run's last mission. */
  finished: boolean;
  /** Clearing it unlocks the full hundred -- true only on the first run's end. */
  unlocksHundred: boolean;
}

export function missionCleared(run: CampaignRun): ClearResult {
  const bonusLife = run.mission % BONUS_LIFE_EVERY === 0;
  const finished = run.mission >= run.length;
  return {
    run: {
      ...run,
      mission: finished ? run.mission : run.mission + 1,
      lives: run.lives + (bonusLife ? 1 : 0),
    },
    bonusLife,
    finished,
    unlocksHundred: finished && run.length === FIRST_RUN_MISSIONS,
  };
}

export interface LossResult {
  run: CampaignRun;
  /** No lives left: the run is over. */
  gameOver: boolean;
}

/** The player's tank was destroyed. The mission is replayed if a life is left. */
export function tankLost(run: CampaignRun): LossResult {
  const lives = run.lives - 1;
  return { run: { ...run, lives }, gameOver: lives <= 0 };
}

// --- Missions ---------------------------------------------------------------

/**
 * The mission each kind first appears in, in the order the original brings them
 * in. After that it keeps appearing, more often the more recently it arrived.
 */
export const KIND_INTRODUCED: [TankKind, number][] = [
  [TankKind.Brown, 1],
  [TankKind.Grey, 3],
  [TankKind.Teal, 6],
  [TankKind.Yellow, 9],
  [TankKind.Red, 12],
  [TankKind.Green, 15],
  [TankKind.Purple, 19],
  [TankKind.White, 24],
  [TankKind.Black, 30],
];

const KIND_CHAR: Record<number, string> = {
  [TankKind.Brown]: 'b',
  [TankKind.Grey]: 'g',
  [TankKind.Teal]: 't',
  [TankKind.Yellow]: 'y',
  [TankKind.Green]: 'n',
  [TankKind.Black]: 'k',
  [TankKind.Red]: 'r',
  [TankKind.Purple]: 'p',
  [TankKind.White]: 'w',
};

/** Enemies in a generated mission: 2 at first, one more every 8 missions, at most 7. */
export function enemyCount(mission: number): number {
  return Math.min(7, 2 + Math.floor((mission - 1) / 8));
}

/** The field inside the border, the original's. */
const FIELD_W = 22;
const FIELD_H = 17;
const W = FIELD_W + 2;
const H = FIELD_H + 2;

const cache = new Map<number, Mission>();

/** Mission `n` of the campaign, 1 to 100. */
export function campaignMission(n: number): Mission {
  if (n < 1 || n > CAMPAIGN_MISSIONS || !Number.isInteger(n)) {
    throw new Error(`there is no campaign mission ${n}; they run 1 to ${CAMPAIGN_MISSIONS}`);
  }
  const authored = MISSIONS.find((m) => m.id === n);
  if (authored) return authored;
  let m = cache.get(n);
  if (!m) {
    m = generateMission(n);
    cache.set(n, m);
  }
  return m;
}

/**
 * Any map by the id a MatchStart carries: a campaign mission (1-100) or a
 * versus arena (101+). What a phone joining a networked mission looks it up by.
 */
export function mapById(id: number): Mission | undefined {
  if (Number.isInteger(id) && id >= 1 && id <= CAMPAIGN_MISSIONS) return campaignMission(id);
  return missionById(id);
}

/**
 * A mission built from its number alone.
 *
 * Mirrored left to right, as many of the original's are, with the player on the
 * left and the enemies on the right. Every enemy must be reachable from the
 * player's spawn over open floor; a layout that fails that is thrown away and
 * the next one drawn, which stays deterministic because the draws come from
 * the same seeded generator.
 */
export function generateMission(n: number): Mission {
  const rng = new Rng(0x7a4e + n * 7919);
  for (let attempt = 0; attempt < 64; attempt++) {
    const rows = tryLayout(n, rng);
    if (rows) return { id: n, name: `Mission ${n}`, rows };
  }
  // Not reached for 1-100 (a test sweeps them), but an open field is always valid.
  return { id: n, name: `Mission ${n}`, rows: openLayout(n, rng) };
}

type Grid = string[][];

function blankGrid(): Grid {
  const g: Grid = [];
  for (let y = 0; y < H; y++) {
    const row: string[] = [];
    for (let x = 0; x < W; x++) row.push(y === 0 || y === H - 1 || x === 0 || x === W - 1 ? '#' : '.');
    g.push(row);
  }
  return g;
}

/** Set a tile and its mirror across the vertical centre line. */
function setMirrored(g: Grid, x: number, y: number, ch: string): void {
  if (x < 1 || x > W - 2 || y < 1 || y > H - 2) return;
  g[y][x] = ch;
  g[y][W - 1 - x] = ch;
}

function tryLayout(n: number, rng: Rng): string[] | null {
  const g = blankGrid();

  // Obstacles on the left half, mirrored. Holes arrive a little later, as they
  // do in the original, and blocks that break are mixed in with walls.
  const features = rng.int(4, 7);
  for (let f = 0; f < features; f++) {
    const roll = rng.next();
    const ch = n >= 10 && roll < 0.2 ? 'O' : roll < 0.55 ? '#' : '%';
    const x0 = rng.int(3, W / 2 - 1);
    const y0 = rng.int(2, H - 3);
    const shape = rng.int(0, 2);
    if (shape === 0) {
      const len = rng.int(2, 5);
      for (let i = 0; i < len; i++) setMirrored(g, x0 + i, y0, ch);
    } else if (shape === 1) {
      const len = rng.int(2, 5);
      for (let i = 0; i < len; i++) setMirrored(g, x0, y0 + i, ch);
    } else {
      const s = rng.int(2, 3);
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) setMirrored(g, x0 + dx, y0 + dy, ch);
    }
  }

  // Player spawns on the left: '1', and '2' beside it for a second player.
  const py = rng.int(3, H - 5);
  const px = 2;
  clearAround(g, px, py, 2);
  clearAround(g, px, py + 2, 1);
  g[py][px] = '1';
  g[py + 2][px] = '2';

  // Enemies on the right half, apart from one another.
  const kinds = pickKinds(n, rng);
  const placed: [number, number][] = [];
  for (const kind of kinds) {
    let ok = false;
    for (let t = 0; t < 40 && !ok; t++) {
      const x = rng.int(W / 2 + 1, W - 3);
      const y = rng.int(2, H - 3);
      if (placed.some(([ex, ey]) => Math.abs(ex - x) + Math.abs(ey - y) < 3)) continue;
      clearAround(g, x, y, 1);
      g[y][x] = KIND_CHAR[kind];
      placed.push([x, y]);
      ok = true;
    }
    if (!ok) return null;
  }

  if (!allReachable(g, px, py, placed)) return null;
  return g.map((r) => r.join(''));
}

function openLayout(n: number, rng: Rng): string[] {
  const g = blankGrid();
  const py = Math.floor(H / 2);
  g[py][2] = '1';
  g[py + 2][2] = '2';
  pickKinds(n, rng).forEach((kind, i) => {
    g[2 + ((i * 2) % (H - 4))][W - 3 - Math.floor(i / 7) * 2] = KIND_CHAR[kind];
  });
  return g.map((r) => r.join(''));
}

function clearAround(g: Grid, cx: number, cy: number, r: number): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x >= 1 && x <= W - 2 && y >= 1 && y <= H - 2 && g[y][x] !== '1' && g[y][x] !== '2') g[y][x] = '.';
    }
  }
}

/** Kinds for mission n: only those introduced by then, recent ones more often. */
function pickKinds(n: number, rng: Rng): TankKind[] {
  const pool = KIND_INTRODUCED.filter(([, from]) => from <= n);
  const weights = pool.map((_, i) => 1 + i);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: TankKind[] = [];
  for (let i = 0; i < enemyCount(n); i++) {
    let r = rng.next() * total;
    let k = 0;
    while (r >= weights[k]) r -= weights[k++];
    out.push(pool[k][0]);
  }
  // The newest kind shows up the mission it is introduced, as in the original.
  const debut = KIND_INTRODUCED.find(([, from]) => from === n);
  if (debut && !out.includes(debut[0])) out[0] = debut[0];
  return out;
}

/** Floor-only flood fill from the player: every enemy must be on it. */
function allReachable(g: Grid, px: number, py: number, enemies: [number, number][]): boolean {
  const seen = new Set<number>();
  const stack: [number, number][] = [[px, py]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    const k = y * W + x;
    if (seen.has(k)) continue;
    const ch = g[y][x];
    if (ch === '#' || ch === '%' || ch === 'O') continue;
    seen.add(k);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return enemies.every(([x, y]) => seen.has(y * W + x));
}

// --- Co-op ------------------------------------------------------------------

/**
 * The two-player campaign, as the original has it: twenty missions, the
 * players on one team, one life each.
 *
 * A mission is cleared when its enemies are gone with any player still
 * standing, and the next one starts with everybody back -- a player who died
 * is revived by a partner who finished the job. If every player is destroyed
 * it is over, and the campaign starts again from mission one. A round that
 * runs out the clock with both sides still up is replayed.
 */
export const COOP_MISSIONS = 20;
/** Players' team in a co-op mission; the mission's enemies are on team 1. */
export const COOP_PLAYER_TEAM = 0;

export type CoopOutcome = 'cleared' | 'failed' | 'timeout';

export interface CoopStep {
  /** The mission to play next. */
  mission: number;
  /** The players cleared mission 20: the campaign is complete, and starts over. */
  completed: boolean;
}

export function coopNext(mission: number, outcome: CoopOutcome): CoopStep {
  if (outcome === 'timeout') return { mission, completed: false };
  if (outcome === 'failed') return { mission: 1, completed: false };
  if (mission >= COOP_MISSIONS) return { mission: 1, completed: true };
  return { mission: mission + 1, completed: false };
}

/** A round's winning team (or DRAW, -1, or null) as a co-op outcome. */
export function coopOutcome(winner: number | null): CoopOutcome {
  if (winner === COOP_PLAYER_TEAM) return 'cleared';
  if (winner === null || winner < 0) return 'timeout';
  return 'failed';
}
