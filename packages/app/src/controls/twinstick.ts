/**
 * Twin-stick touch controls.
 *
 * Framework-agnostic on purpose: feed it pointer down/move/up and read a
 * TankInput out. That keeps it unit-testable without a renderer, and it means
 * the same logic serves Skia on device and a canvas harness on desktop.
 *
 * ## Why floating sticks
 *
 * The arena fills the full height of a 16:9 phone (see render/viewport.ts), so
 * there is no room for fixed sticks beside it — they have to overlay the play
 * area. Fixed overlay sticks are the worst of both worlds: they cover the arena
 * *and* you have to look down to find them. Floating sticks appear wherever the
 * thumb lands, so they cover nothing until touched and never need looking at.
 *
 * ## Why two fire modes
 *
 * Wii Play aimed with the Wii pointer (absolute) and fired with B. Neither half
 * survives the move to touch, so the binding is an open design question and
 * Session A explicitly asked for a verdict on feel. Both are implemented:
 *
 *   'button'  — right stick aims, a dedicated button fires. Conventional, and
 *               lets you hold an aim indefinitely. Costs a cramped right thumb,
 *               because the stick and the button share it.
 *   'release' — right stick aims, lifting the thumb fires. One thumb, no
 *               cramping, and holding an aim is just keeping the thumb down,
 *               which reads like drawing a bow. Costs you the ability to
 *               reposition the thumb without shooting — expensive against a
 *               5-shell budget, which is why releases inside the dead zone are
 *               swallowed rather than fired.
 *
 * Render-only and input-only code, so Math.* is fine here. The determinism rule
 * binds only what reaches step(), and this produces a TankInput which is then
 * quantised on the wire anyway.
 */

import { emptyInput, type TankInput } from '@tanks/core';

export type FireMode = 'button' | 'release';

export interface TwinStickConfig {
  screenW: number;
  screenH: number;
  /** Travel from origin, in px, at which the stick reads full deflection. */
  stickRadiusPx: number;
  /** Travel below which the stick reads zero. Kills thumb tremor. */
  deadZonePx: number;
  fireMode: FireMode;
}

export const DEFAULT_CONFIG: Omit<TwinStickConfig, 'screenW' | 'screenH'> = {
  stickRadiusPx: 56,
  deadZonePx: 9,
  fireMode: 'button',
};

interface StickTouch {
  pointerId: number;
  /** Where the finger first landed — the stick's centre. */
  ox: number;
  oy: number;
  /** Where the finger is now. */
  px: number;
  py: number;
  /** Has this touch ever left the dead zone? Gates release-to-fire. */
  everDeflected: boolean;
}

export interface StickView {
  active: boolean;
  ox: number;
  oy: number;
  /** Knob position, already clamped to stickRadiusPx. */
  kx: number;
  ky: number;
}

/** What the renderer needs to draw the controls. */
export interface ControlsView {
  drive: StickView;
  aim: StickView;
  fireHeld: boolean;
  mineHeld: boolean;
}

const INACTIVE: StickView = { active: false, ox: 0, oy: 0, kx: 0, ky: 0 };

export class TwinStickControls {
  private drive: StickTouch | null = null;
  private aim: StickTouch | null = null;
  private firePointer = -1;
  private minePointer = -1;

  /** Latched for exactly one frame — sim reads `fire` as an edge, not a level. */
  private firePulse = false;
  private minePulse = false;

  constructor(private cfg: TwinStickConfig) {}

  setConfig(cfg: Partial<TwinStickConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get config(): Readonly<TwinStickConfig> {
    return this.cfg;
  }

  /** Circular fire button, bottom-right. Only present in 'button' mode. */
  fireButton(): { x: number; y: number; r: number } {
    const r = 42;
    return { x: this.cfg.screenW - r - 26, y: this.cfg.screenH - r - 22, r };
  }

  /** Mine button, tucked above and inboard of fire so a thumb can reach both. */
  mineButton(): { x: number; y: number; r: number } {
    const r = 32;
    const fire = this.fireButton();
    return { x: fire.x - fire.r - r - 12, y: fire.y - fire.r - r + 22, r };
  }

  private hits(
    btn: { x: number; y: number; r: number },
    x: number,
    y: number,
  ): boolean {
    const dx = x - btn.x;
    const dy = y - btn.y;
    // Generous: fingers are imprecise and a missed fire button is a lost shot.
    const r = btn.r * 1.35;
    return dx * dx + dy * dy <= r * r;
  }

  onPointerDown(id: number, x: number, y: number): void {
    if (this.cfg.fireMode === 'button') {
      if (this.firePointer < 0 && this.hits(this.fireButton(), x, y)) {
        this.firePointer = id;
        this.firePulse = true;
        return;
      }
      if (this.minePointer < 0 && this.hits(this.mineButton(), x, y)) {
        this.minePointer = id;
        this.minePulse = true;
        return;
      }
    }

    const leftHalf = x < this.cfg.screenW / 2;
    const touch: StickTouch = {
      pointerId: id,
      ox: x,
      oy: y,
      px: x,
      py: y,
      everDeflected: false,
    };
    // A stick already owned by another finger is not stolen — the second touch
    // on the same half is ignored rather than yanking the stick out from under
    // the first, which would read as a control glitch mid-fight.
    if (leftHalf) {
      if (!this.drive) this.drive = touch;
    } else if (!this.aim) {
      this.aim = touch;
    }
  }

  onPointerMove(id: number, x: number, y: number): void {
    for (const s of [this.drive, this.aim]) {
      if (s && s.pointerId === id) {
        s.px = x;
        s.py = y;
        if (Math.hypot(x - s.ox, y - s.oy) > this.cfg.deadZonePx) {
          s.everDeflected = true;
        }
      }
    }
  }

  onPointerUp(id: number): void {
    if (this.firePointer === id) this.firePointer = -1;
    if (this.minePointer === id) this.minePointer = -1;

    if (this.drive?.pointerId === id) this.drive = null;

    if (this.aim?.pointerId === id) {
      // Release-to-fire: only if this touch was a real aim, never a stray tap.
      // Against a 5-shell budget an accidental shot is genuinely costly.
      if (this.cfg.fireMode === 'release' && this.aim.everDeflected) {
        this.firePulse = true;
      }
      this.aim = null;
    }
  }

  /** Drop all touch state — call on blur, pause, or orientation change. */
  cancelAll(): void {
    this.drive = null;
    this.aim = null;
    this.firePointer = -1;
    this.minePointer = -1;
    this.firePulse = false;
    this.minePulse = false;
  }

  private vector(s: StickTouch | null): { x: number; y: number } {
    if (!s) return { x: 0, y: 0 };
    const dx = s.px - s.ox;
    const dy = s.py - s.oy;
    const len = Math.hypot(dx, dy);
    if (len <= this.cfg.deadZonePx) return { x: 0, y: 0 };

    // Re-map (deadZone, radius] onto (0, 1] so the stick starts moving from
    // zero at the dead-zone edge instead of jumping to a step.
    const t = Math.min(
      1,
      (len - this.cfg.deadZonePx) /
        Math.max(1, this.cfg.stickRadiusPx - this.cfg.deadZonePx),
    );
    return { x: (dx / len) * t, y: (dy / len) * t };
  }

  /**
   * Sample the controls into a TankInput.
   *
   * Consumes the fire/mine pulses, so call exactly once per simulation tick.
   * Calling it twice in a tick silently eats a shot.
   */
  sample(): TankInput {
    const input = emptyInput();
    const d = this.vector(this.drive);
    input.moveX = d.x;
    input.moveY = d.y;

    const a = this.vector(this.aim);
    // Zero-length aim means "hold current turret angle" per Session A's
    // contract, and vector() already returns exactly that inside the dead zone.
    input.aimX = a.x;
    input.aimY = a.y;

    input.fire = this.firePulse || this.firePointer >= 0;
    input.layMine = this.minePulse || this.minePointer >= 0;
    this.firePulse = false;
    this.minePulse = false;
    return input;
  }

  /** Snapshot for the renderer. Does not consume pulses. */
  view(): ControlsView {
    const mk = (s: StickTouch | null): StickView => {
      if (!s) return INACTIVE;
      const dx = s.px - s.ox;
      const dy = s.py - s.oy;
      const len = Math.hypot(dx, dy);
      const clamped = Math.min(len, this.cfg.stickRadiusPx);
      const k = len > 0 ? clamped / len : 0;
      return { active: true, ox: s.ox, oy: s.oy, kx: dx * k, ky: dy * k };
    };
    return {
      drive: mk(this.drive),
      aim: mk(this.aim),
      fireHeld: this.firePointer >= 0,
      mineHeld: this.minePointer >= 0,
    };
  }
}
