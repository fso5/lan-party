/**
 * World <-> screen mapping.
 *
 * Session A's arenas are 24x14 tiles and there is deliberately no scrolling
 * camera — seeing every bank shot coming is the game. So the whole arena is
 * letterboxed into the screen and the scale falls out of whichever axis is
 * tighter.
 *
 * On a 16:9 phone held sideways (844x390) that gives min(844/24, 390/14) =
 * 27.9 px/tile, so the arena draws 669x390: full height, with ~87px of slack on
 * each side. That slack is not enough for thumbsticks beside the arena, which
 * is why the controls overlay it instead — see controls/stick.ts.
 *
 * Everything here is render-only, so Math.* is fine. The determinism rule binds
 * only code whose output reaches step().
 */

export interface Viewport {
  /** Pixels per world tile. */
  scale: number;
  /** Screen position of world origin (0,0). */
  originX: number;
  originY: number;
  /** Size of the drawn arena in pixels. */
  drawW: number;
  drawH: number;
  screenW: number;
  screenH: number;
}

export function fitArena(
  screenW: number,
  screenH: number,
  arenaW: number,
  arenaH: number,
  padding = 0,
): Viewport {
  const usableW = Math.max(1, screenW - padding * 2);
  const usableH = Math.max(1, screenH - padding * 2);
  const scale = Math.min(usableW / arenaW, usableH / arenaH);
  const drawW = arenaW * scale;
  const drawH = arenaH * scale;
  return {
    scale,
    originX: (screenW - drawW) / 2,
    originY: (screenH - drawH) / 2,
    drawW,
    drawH,
    screenW,
    screenH,
  };
}

/** World X (tiles) -> screen X (px). */
export function sx(v: Viewport, x: number): number {
  return v.originX + x * v.scale;
}

/** World Y (tiles) -> screen Y (px). */
export function sy(v: Viewport, y: number): number {
  return v.originY + y * v.scale;
}

/** World length (tiles) -> screen length (px). */
export function sl(v: Viewport, len: number): number {
  return len * v.scale;
}

/** Screen X (px) -> world X (tiles). */
export function wx(v: Viewport, px: number): number {
  return (px - v.originX) / v.scale;
}

/** Screen Y (px) -> world Y (tiles). */
export function wy(v: Viewport, py: number): number {
  return (py - v.originY) / v.scale;
}
