/**
 * Arena representation.
 *
 * The arena is a dense grid of tiles. Tile (0,0) spans world coordinates
 * [0,1) x [0,1), so world position and grid index differ only by a floor(). The
 * outer ring is always Wall, which means collision code never needs a separate
 * "left the arena" branch -- you always hit a wall first.
 */

import { Tile, blocksShell, blocksTank, type TeamId } from './types.js';
// The one thing the map layer takes from the wire format. Worth the dependency
// -- protocol.ts imports nothing, so there is no cycle, and the alternative is
// a second copy of the limit that nobody thinks to update.
import { MAX_WIRE_POS } from './net/protocol.js';

export interface SpawnPoint {
  x: number;
  y: number;
  angle: number;
  /** Which team spawns here. Team 0 is the player side. */
  team: TeamId;
}

export interface EnemyPlacement {
  kind: number; // TankKind
  x: number;
  y: number;
  angle: number;
  team: TeamId;
}

export interface ArenaDef {
  name: string;
  width: number;
  height: number;
  /** Row-major, length width*height. */
  tiles: Tile[];
  spawns: SpawnPoint[];
  enemies: EnemyPlacement[];
}

export class Arena {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly tiles: Uint8Array;
  readonly spawns: SpawnPoint[];
  readonly enemies: EnemyPlacement[];

  constructor(def: ArenaDef) {
    if (def.tiles.length !== def.width * def.height) {
      throw new Error(
        `arena "${def.name}": expected ${def.width * def.height} tiles, got ${def.tiles.length}`,
      );
    }
    this.name = def.name;
    this.width = def.width;
    this.height = def.height;
    this.tiles = Uint8Array.from(def.tiles);
    this.spawns = def.spawns.map((s) => ({ ...s }));
    this.enemies = def.enemies.map((e) => ({ ...e }));
    this.sealBorder();
  }

  /** Force the outer ring to Wall so nothing can ever escape the grid. */
  private sealBorder(): void {
    const { width: w, height: h } = this;
    for (let x = 0; x < w; x++) {
      this.tiles[x] = Tile.Wall;
      this.tiles[(h - 1) * w + x] = Tile.Wall;
    }
    for (let y = 0; y < h; y++) {
      this.tiles[y * w] = Tile.Wall;
      this.tiles[y * w + (w - 1)] = Tile.Wall;
    }
  }

  index(cx: number, cy: number): number {
    return cy * this.width + cx;
  }

  /** Tile at a grid cell. Out-of-bounds reads as Wall. */
  at(cx: number, cy: number): Tile {
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return Tile.Wall;
    return this.tiles[cy * this.width + cx] as Tile;
  }

  /** Tile at a world position. */
  atWorld(x: number, y: number): Tile {
    return this.at(Math.floor(x), Math.floor(y));
  }

  set(cx: number, cy: number, t: Tile): void {
    if (cx <= 0 || cy <= 0 || cx >= this.width - 1 || cy >= this.height - 1) return;
    this.tiles[cy * this.width + cx] = t;
  }

  blocksTankAt(cx: number, cy: number): boolean {
    return blocksTank(this.at(cx, cy));
  }

  blocksShellAt(cx: number, cy: number): boolean {
    return blocksShell(this.at(cx, cy));
  }

  /**
   * Line-of-sight test for shells, ignoring tank bodies.
   *
   * Used by the AI to decide whether it has a direct shot. Walks the grid with
   * a DDA rather than sampling at fixed intervals, so it cannot tunnel through
   * a one-tile-thick wall the way a naive stepped raycast does.
   */
  hasShellLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-9) return true;

    const nx = dx / dist;
    const ny = dy / dist;

    let cx = Math.floor(x0);
    let cy = Math.floor(y0);
    const stepX = nx > 0 ? 1 : -1;
    const stepY = ny > 0 ? 1 : -1;

    // Distance along the ray to the next grid line in each axis.
    const invX = nx === 0 ? Infinity : 1 / (nx > 0 ? nx : -nx);
    const invY = ny === 0 ? Infinity : 1 / (ny > 0 ? ny : -ny);
    let tMaxX = nx === 0 ? Infinity : (nx > 0 ? cx + 1 - x0 : x0 - cx) * invX;
    let tMaxY = ny === 0 ? Infinity : (ny > 0 ? cy + 1 - y0 : y0 - cy) * invY;

    let travelled = 0;
    // Bound the walk: the ray cannot cross more cells than the grid diagonal.
    const maxSteps = this.width + this.height + 2;
    for (let i = 0; i < maxSteps; i++) {
      if (tMaxX < tMaxY) {
        travelled = tMaxX;
        if (travelled >= dist) return true;
        cx += stepX;
        tMaxX += invX;
      } else {
        travelled = tMaxY;
        if (travelled >= dist) return true;
        cy += stepY;
        tMaxY += invY;
      }
      if (this.blocksShellAt(cx, cy)) return false;
    }
    return true;
  }

  /** True if a tank of the given radius can occupy this world position. */
  canTankOccupy(x: number, y: number, radius: number): boolean {
    const minX = Math.floor(x - radius);
    const maxX = Math.floor(x + radius);
    const minY = Math.floor(y - radius);
    const maxY = Math.floor(y + radius);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        if (this.blocksTankAt(cx, cy)) return false;
      }
    }
    return true;
  }

  clone(): Arena {
    const a = Object.create(Arena.prototype) as Arena;
    (a as { name: string }).name = this.name;
    (a as { width: number }).width = this.width;
    (a as { height: number }).height = this.height;
    (a as { tiles: Uint8Array }).tiles = this.tiles.slice();
    (a as { spawns: SpawnPoint[] }).spawns = this.spawns.map((s) => ({ ...s }));
    (a as { enemies: EnemyPlacement[] }).enemies = this.enemies.map((e) => ({ ...e }));
    return a;
  }
}

/**
 * Parse an arena from ASCII art. This is the authoring format -- it is far
 * easier to eyeball a level as text than as an array of integers, and it makes
 * map diffs readable in code review.
 *
 *   '#' indestructible wall     '.' or ' ' floor
 *   '%' destructible block      'O' hole
 *   '1'-'4' team spawn points (digit is the team index + 1)
 *   'b','g','t','y','n','k' enemy tanks (brown/grey/teal/yellow/greeN/blacK)
 *
 * Enemies parsed from ASCII default to team 1 (the AI side).
 */
export function parseArena(name: string, rows: string[]): ArenaDef {
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));

  // Refuse an arena the protocol cannot describe, at the moment it is authored
  // rather than mid-match on somebody else's phone. Issue #2 asked for exactly
  // this insurance and it was the half of that finding still missing: quantPos
  // was taught to clamp instead of wrap, which turns a teleport into a tank
  // permanently stuck against an invisible wall -- better, still silent, and
  // still nothing a map author would connect to a wire format.
  if (width > MAX_WIRE_POS || height > MAX_WIRE_POS) {
    throw new Error(
      `arena '${name}' is ${width}x${height}, and the wire format cannot carry a ` +
        `coordinate past ${MAX_WIRE_POS} tiles -- tanks beyond that would appear ` +
        'pinned at the edge on every phone but the host',
    );
  }

  const tiles: Tile[] = new Array(width * height).fill(Tile.Floor);
  const spawns: SpawnPoint[] = [];
  const enemies: EnemyPlacement[] = [];

  const enemyChars: Record<string, number> = { b: 1, g: 2, t: 3, y: 4, n: 5, k: 6 };

  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      const ch = x < row.length ? row[x] : ' ';
      const i = y * width + x;
      // Centre of the cell, which is where entities are placed.
      const wx = x + 0.5;
      const wy = y + 0.5;

      if (ch === '#') tiles[i] = Tile.Wall;
      else if (ch === '%') tiles[i] = Tile.Block;
      else if (ch === 'O') tiles[i] = Tile.Hole;
      else if (ch >= '1' && ch <= '8') {
        spawns.push({ x: wx, y: wy, angle: 0, team: ch.charCodeAt(0) - 49 });
      } else if (enemyChars[ch] !== undefined) {
        enemies.push({ kind: enemyChars[ch], x: wx, y: wy, angle: 0, team: 1 });
      }
    }
  }

  /*
   * Refuse the same start digit twice, for the same reason as the size check
   * above: at the moment the map is authored, not on somebody's phone.
   *
   * Maps here are hand-drawn ASCII, deliberately, so a level reads as a picture
   * in source -- and the cost of that is that '1' typed twice looks exactly
   * like a level. Measured before adding this: it parsed, quietly, into two
   * spawn points both carrying team 0.
   *
   * That is not a cosmetic duplicate. `createWorld` gives each seat the team of
   * its spawn, and every hostility decision in the simulation keys off `team`,
   * so two seats sharing one means two people standing in a free-for-all unable
   * to damage each other for the whole round. The same symptom is open against
   * the lobby as issue #9; it should not also be reachable by drawing a map.
   */
  const byDigit = new Map<number, number>();
  for (const s of spawns) byDigit.set(s.team, (byDigit.get(s.team) ?? 0) + 1);
  for (const [team, count] of byDigit) {
    if (count > 1) {
      throw new Error(
        `arena '${name}' places start '${team + 1}' ${count} times -- each digit is one ` +
          'seat, and two seats on one team cannot hurt each other in a free-for-all',
      );
    }
  }

  // Ordered by the digit that authored them, not by where they fall in the
  // text. `createWorld` indexes this array by `spawnIndex`, so leaving it in
  // scan order means a map that happens to write '3' above '1' hands seat 0 the
  // third start -- a silent mismatch between what a lobby shows and where a
  // player appears, and one that would only ever bite the map authored last.
  spawns.sort((a, b) => a.team - b.team);

  return { name, width, height, tiles, spawns, enemies };
}
