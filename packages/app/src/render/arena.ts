/**
 * Static arena layer.
 *
 * A 24x14 arena is 336 tiles. Emitting those as React nodes every frame would
 * dominate the frame budget for no reason: the grid only ever changes when a
 * shell destroys a cork block. So the whole floor + walls + blocks layer is
 * recorded once into an SkPicture and replayed each frame as a single draw,
 * and we re-record only when the tile grid actually changes.
 *
 * Entities (tanks, shells, mines) are ~30 nodes and are drawn declaratively on
 * top — that count is small enough that React reconciliation is not a problem.
 */

import { Skia, type SkPicture } from '@shopify/react-native-skia';
import { Tile, type Arena } from '@tanks/core';
import { sl, sx, sy, type Viewport } from './viewport';

export const PALETTE = {
  floor: '#c9b899',
  floorAlt: '#c3b191',
  wall: '#5b4636',
  wallTop: '#6d5643',
  block: '#b5773f',
  blockTop: '#c98a4b',
  blockSeam: '#8f5c2e',
  hole: '#241d17',
  holeRim: '#3a2f25',
  background: '#0d1117',
} as const;

/**
 * Cheap checkerboard on the floor.
 *
 * Not decoration: shells travel in straight lines between bounces and a plain
 * flat floor gives the eye nothing to judge angle against. One-tile squares
 * make a bank shot's path readable, which is the whole skill of this game.
 */
function floorColour(cx: number, cy: number): string {
  return (cx + cy) % 2 === 0 ? PALETTE.floor : PALETTE.floorAlt;
}

export function recordArena(arena: Arena, v: Viewport): SkPicture {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(
    Skia.XYWHRect(0, 0, v.screenW, v.screenH),
  );

  const paint = Skia.Paint();
  paint.setAntiAlias(false);

  const ts = v.scale;
  // Overdraw by a hair so neighbouring tiles never show a seam from rounding.
  const bleed = 0.6;

  for (let cy = 0; cy < arena.height; cy++) {
    for (let cx = 0; cx < arena.width; cx++) {
      const t = arena.at(cx, cy);
      const x = sx(v, cx);
      const y = sy(v, cy);

      // Floor goes under everything -- holes and blocks paint over it.
      paint.setColor(Skia.Color(floorColour(cx, cy)));
      canvas.drawRect(Skia.XYWHRect(x, y, ts + bleed, ts + bleed), paint);

      if (t === Tile.Wall) {
        paint.setColor(Skia.Color(PALETTE.wall));
        canvas.drawRect(Skia.XYWHRect(x, y, ts + bleed, ts + bleed), paint);
        // A lighter cap on the upper portion reads as height from directly
        // above, which is what separates a wall from a flat painted tile.
        paint.setColor(Skia.Color(PALETTE.wallTop));
        canvas.drawRect(Skia.XYWHRect(x, y, ts + bleed, ts * 0.7), paint);
      } else if (t === Tile.Block) {
        paint.setColor(Skia.Color(PALETTE.block));
        canvas.drawRect(Skia.XYWHRect(x, y, ts + bleed, ts + bleed), paint);
        paint.setColor(Skia.Color(PALETTE.blockTop));
        canvas.drawRect(
          Skia.XYWHRect(x + ts * 0.06, y + ts * 0.06, ts * 0.88, ts * 0.62),
          paint,
        );
        paint.setColor(Skia.Color(PALETTE.blockSeam));
        canvas.drawRect(
          Skia.XYWHRect(x + ts * 0.06, y + ts * 0.52, ts * 0.88, ts * 0.06),
          paint,
        );
      } else if (t === Tile.Hole) {
        paint.setColor(Skia.Color(PALETTE.holeRim));
        canvas.drawRect(Skia.XYWHRect(x, y, ts + bleed, ts + bleed), paint);
        paint.setColor(Skia.Color(PALETTE.hole));
        canvas.drawOval(
          Skia.XYWHRect(x + ts * 0.08, y + ts * 0.08, ts * 0.84, ts * 0.84),
          paint,
        );
      }
    }
  }

  return recorder.finishRecordingAsPicture();
}

/**
 * Cheap change-detector for the tile grid.
 *
 * Session A's sim emits a BlockDestroyed event, but relying on catching every
 * event means a single missed drain leaves the arena permanently wrong on
 * screen. Hashing the grid is O(tiles) once per frame — trivial next to
 * re-recording — and cannot drift out of sync with reality.
 */
export function arenaHash(arena: Arena): number {
  let h = 2166136261 >>> 0;
  for (let cy = 0; cy < arena.height; cy++) {
    for (let cx = 0; cx < arena.width; cx++) {
      h ^= arena.at(cx, cy);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h;
}

export function arenaGeometry(v: Viewport) {
  return {
    tankRadiusPx: (r: number) => sl(v, r),
  };
}
