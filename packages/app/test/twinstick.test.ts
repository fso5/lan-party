import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  TwinStickControls,
  type FireMode,
} from '../src/controls/twinstick';

const SCREEN_W = 844;
const SCREEN_H = 390;

function make(fireMode: FireMode = 'button') {
  return new TwinStickControls({
    ...DEFAULT_CONFIG,
    screenW: SCREEN_W,
    screenH: SCREEN_H,
    fireMode,
  });
}

/** Somewhere unambiguously in the left (drive) half, clear of any button. */
const LEFT = { x: 150, y: 250 };
/** Right (aim) half, clear of the fire and mine buttons. */
const RIGHT = { x: 520, y: 120 };

describe('stick vectors', () => {
  it('reads zero inside the dead zone', () => {
    const c = make();
    c.onPointerDown(1, LEFT.x, LEFT.y);
    // Move by less than deadZonePx (9).
    c.onPointerMove(1, LEFT.x + 5, LEFT.y);
    const input = c.sample();
    expect(input.moveX).toBe(0);
    expect(input.moveY).toBe(0);
  });

  it('reaches full deflection at the stick radius', () => {
    const c = make();
    c.onPointerDown(1, LEFT.x, LEFT.y);
    c.onPointerMove(1, LEFT.x + DEFAULT_CONFIG.stickRadiusPx, LEFT.y);
    const input = c.sample();
    expect(input.moveX).toBeCloseTo(1, 5);
    expect(input.moveY).toBeCloseTo(0, 5);
  });

  it('clamps beyond the radius instead of exceeding 1', () => {
    const c = make();
    c.onPointerDown(1, LEFT.x, LEFT.y);
    c.onPointerMove(1, LEFT.x + 400, LEFT.y);
    const input = c.sample();
    expect(input.moveX).toBeCloseTo(1, 5);
    expect(Math.hypot(input.moveX, input.moveY)).toBeLessThanOrEqual(1.0000001);
  });

  it('ramps from zero at the dead-zone edge rather than jumping', () => {
    const c = make();
    c.onPointerDown(1, LEFT.x, LEFT.y);
    // One pixel past the dead zone should be a small value, not a large step.
    c.onPointerMove(1, LEFT.x + DEFAULT_CONFIG.deadZonePx + 1, LEFT.y);
    const input = c.sample();
    expect(input.moveX).toBeGreaterThan(0);
    expect(input.moveX).toBeLessThan(0.1);
  });
});

describe('lane routing', () => {
  it('routes a left-half touch to drive and a right-half touch to aim', () => {
    const c = make();
    c.onPointerDown(1, LEFT.x, LEFT.y);
    c.onPointerDown(2, RIGHT.x, RIGHT.y);
    c.onPointerMove(1, LEFT.x, LEFT.y + DEFAULT_CONFIG.stickRadiusPx);
    c.onPointerMove(2, RIGHT.x + DEFAULT_CONFIG.stickRadiusPx, RIGHT.y);

    const input = c.sample();
    expect(input.moveY).toBeCloseTo(1, 5);
    expect(input.moveX).toBeCloseTo(0, 5);
    expect(input.aimX).toBeCloseTo(1, 5);
    expect(input.aimY).toBeCloseTo(0, 5);
  });

  it('does not let a second finger steal a stick already in use', () => {
    const c = make();
    c.onPointerDown(1, LEFT.x, LEFT.y);
    c.onPointerMove(1, LEFT.x + DEFAULT_CONFIG.stickRadiusPx, LEFT.y);
    // A second finger lands on the same half.
    c.onPointerDown(2, LEFT.x + 200, LEFT.y);
    c.onPointerMove(2, LEFT.x + 200, LEFT.y - DEFAULT_CONFIG.stickRadiusPx);

    // The original finger still owns the stick, so X is still deflected and the
    // interloper's upward drag has not taken over.
    const input = c.sample();
    expect(input.moveX).toBeCloseTo(1, 5);
    expect(input.moveY).toBeCloseTo(0, 5);
  });

  it('keeps a stick owned by the finger that started it, across the midline', () => {
    const c = make();
    c.onPointerDown(1, LEFT.x, LEFT.y);
    // Drag the drive finger well into the right half.
    c.onPointerMove(1, 700, LEFT.y);
    const input = c.sample();
    // It is still the drive stick, fully deflected -- not reassigned to aim.
    expect(input.moveX).toBeCloseTo(1, 5);
    expect(input.aimX).toBe(0);
  });
});

describe('aim hold semantics', () => {
  it('reports zero aim when the aim stick is untouched, meaning hold', () => {
    const c = make();
    c.onPointerDown(1, LEFT.x, LEFT.y);
    c.onPointerMove(1, LEFT.x + DEFAULT_CONFIG.stickRadiusPx, LEFT.y);
    const input = c.sample();
    // Session A's contract: zero-length aim holds the current turret angle.
    expect(input.aimX).toBe(0);
    expect(input.aimY).toBe(0);
  });
});

describe('fire: button mode', () => {
  it('fires when the fire button is pressed', () => {
    const c = make('button');
    const b = c.fireButton();
    c.onPointerDown(1, b.x, b.y);
    expect(c.sample().fire).toBe(true);
  });

  it('keeps firing while the button is held', () => {
    const c = make('button');
    const b = c.fireButton();
    c.onPointerDown(1, b.x, b.y);
    c.sample();
    expect(c.sample().fire).toBe(true);
  });

  it('stops firing once the button is released', () => {
    const c = make('button');
    const b = c.fireButton();
    c.onPointerDown(1, b.x, b.y);
    c.sample();
    c.onPointerUp(1);
    expect(c.sample().fire).toBe(false);
  });

  it('lays a mine from the mine button, without firing', () => {
    const c = make('button');
    const m = c.mineButton();
    c.onPointerDown(1, m.x, m.y);
    const input = c.sample();
    expect(input.layMine).toBe(true);
    expect(input.fire).toBe(false);
  });

  it('does not treat the fire button as an aim stick', () => {
    const c = make('button');
    const b = c.fireButton();
    c.onPointerDown(1, b.x, b.y);
    c.onPointerMove(1, b.x + 60, b.y);
    const input = c.sample();
    expect(input.aimX).toBe(0);
    expect(input.aimY).toBe(0);
  });

  it('does not fire on release in button mode', () => {
    const c = make('button');
    c.onPointerDown(1, RIGHT.x, RIGHT.y);
    c.onPointerMove(1, RIGHT.x + 50, RIGHT.y);
    c.onPointerUp(1);
    expect(c.sample().fire).toBe(false);
  });
});

describe('fire: release mode', () => {
  it('fires when a deflected aim touch is released', () => {
    const c = make('release');
    c.onPointerDown(1, RIGHT.x, RIGHT.y);
    c.onPointerMove(1, RIGHT.x + 50, RIGHT.y);
    c.onPointerUp(1);
    expect(c.sample().fire).toBe(true);
  });

  it('swallows a release that never left the dead zone', () => {
    const c = make('release');
    c.onPointerDown(1, RIGHT.x, RIGHT.y);
    c.onPointerMove(1, RIGHT.x + 3, RIGHT.y);
    c.onPointerUp(1);
    // A stray tap must not cost a shell out of a budget of five.
    expect(c.sample().fire).toBe(false);
  });

  it('does not fire while the aim stick is merely held', () => {
    const c = make('release');
    c.onPointerDown(1, RIGHT.x, RIGHT.y);
    c.onPointerMove(1, RIGHT.x + 50, RIGHT.y);
    expect(c.sample().fire).toBe(false);
  });

  it('does not fire when the drive stick is released', () => {
    const c = make('release');
    c.onPointerDown(1, LEFT.x, LEFT.y);
    c.onPointerMove(1, LEFT.x + 50, LEFT.y);
    c.onPointerUp(1);
    expect(c.sample().fire).toBe(false);
  });
});

describe('pulse consumption', () => {
  it('delivers a release-fire exactly once', () => {
    const c = make('release');
    c.onPointerDown(1, RIGHT.x, RIGHT.y);
    c.onPointerMove(1, RIGHT.x + 50, RIGHT.y);
    c.onPointerUp(1);

    expect(c.sample().fire).toBe(true);
    // Second sample in the same situation must not re-fire: the sim treats fire
    // as an edge, and a pulse surviving two ticks would spend two shells.
    expect(c.sample().fire).toBe(false);
  });

  it('delivers a mine tap exactly once', () => {
    const c = make('button');
    const m = c.mineButton();
    c.onPointerDown(1, m.x, m.y);
    c.onPointerUp(1);
    expect(c.sample().layMine).toBe(true);
    expect(c.sample().layMine).toBe(false);
  });
});

describe('cancelAll', () => {
  it('drops every stick and pending pulse', () => {
    const c = make('button');
    c.onPointerDown(1, LEFT.x, LEFT.y);
    c.onPointerMove(1, LEFT.x + 60, LEFT.y);
    const b = c.fireButton();
    c.onPointerDown(2, b.x, b.y);

    c.cancelAll();

    const input = c.sample();
    expect(input.moveX).toBe(0);
    expect(input.moveY).toBe(0);
    expect(input.fire).toBe(false);
    expect(c.view().drive.active).toBe(false);
  });
});

describe('button placement', () => {
  it('keeps fire and mine buttons on screen', () => {
    const c = make('button');
    for (const b of [c.fireButton(), c.mineButton()]) {
      expect(b.x - b.r).toBeGreaterThan(0);
      expect(b.y - b.r).toBeGreaterThan(0);
      expect(b.x + b.r).toBeLessThan(SCREEN_W);
      expect(b.y + b.r).toBeLessThan(SCREEN_H);
    }
  });

  it('does not overlap the fire and mine buttons', () => {
    const c = make('button');
    const f = c.fireButton();
    const m = c.mineButton();
    const gap = Math.hypot(f.x - m.x, f.y - m.y);
    expect(gap).toBeGreaterThan(f.r + m.r);
  });
});
