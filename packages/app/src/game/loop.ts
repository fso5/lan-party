/**
 * Fixed-timestep driver for the simulation.
 *
 * Session A's contract: the sim runs at exactly 60Hz and you step it in whole
 * ticks. You must never scale a step by a variable frame delta — that makes the
 * result depend on this device's frame pacing, which destroys determinism and
 * therefore destroys netplay, because a client replaying a shell trajectory
 * would diverge from the host's.
 *
 * So real elapsed time goes into an accumulator and comes out as whole ticks.
 */

import { DT, type TankInput } from '@tanks/core';

/**
 * Longest real interval we will try to catch up on, in seconds.
 *
 * Without this, returning from a backgrounded app hands us a delta of many
 * seconds, which becomes hundreds of catch-up ticks, which blocks the frame,
 * which produces an even larger next delta. Games call it the spiral of death.
 * We drop the excess instead: time is lost, the sim stays correct.
 */
const MAX_FRAME_SECONDS = 0.25;

/** Hard ceiling on catch-up work in a single frame, as a second guard. */
const MAX_STEPS_PER_FRAME = 5;

export interface LoopStats {
  /** Ticks advanced on the most recent frame. */
  ticks: number;
  /** Whole frames of real time discarded to avoid a spiral. Should stay 0. */
  droppedFrames: number;
  /** Fraction of a tick left in the accumulator, in [0, 1). */
  alpha: number;
}

export class FixedLoop {
  private acc = 0;
  private lastMs = 0;
  private started = false;
  readonly stats: LoopStats = { ticks: 0, droppedFrames: 0, alpha: 0 };

  constructor(private readonly onTick: (inputs: Map<number, TankInput>) => void) {}

  /** Discard accumulated time — call when resuming from background or a pause. */
  reset(): void {
    this.acc = 0;
    this.started = false;
  }

  /**
   * Advance the simulation to match wall-clock time.
   *
   * `nowMs` should come from the same clock every call (performance.now() or the
   * rAF timestamp — not a mix of the two).
   */
  advance(nowMs: number, inputs: Map<number, TankInput>): void {
    if (!this.started) {
      this.started = true;
      this.lastMs = nowMs;
      this.stats.ticks = 0;
      this.stats.alpha = 0;
      return;
    }

    let elapsed = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;

    // A backwards or absurd clock reading is not worth simulating through.
    if (!(elapsed > 0)) elapsed = 0;
    if (elapsed > MAX_FRAME_SECONDS) {
      elapsed = MAX_FRAME_SECONDS;
      this.stats.droppedFrames++;
    }

    this.acc += elapsed;

    let ticks = 0;
    while (this.acc >= DT && ticks < MAX_STEPS_PER_FRAME) {
      this.onTick(inputs);
      this.acc -= DT;
      ticks++;
    }

    // Hit the per-frame ceiling: drop the backlog rather than carry it into the
    // next frame, where it would only compound.
    if (this.acc >= DT) {
      this.acc = 0;
      this.stats.droppedFrames++;
    }

    this.stats.ticks = ticks;
    this.stats.alpha = this.acc / DT;
  }
}
