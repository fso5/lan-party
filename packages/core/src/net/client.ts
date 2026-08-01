/**
 * Client-side prediction and reconciliation.
 *
 * The problem: over Bluetooth the round trip is 90-150ms. If the client waited
 * for the host to confirm its movement, the tank would visibly lag the thumb by
 * a tenth of a second, which is unplayable for a game where a single shell
 * kills you.
 *
 * So the client runs the same simulation locally and applies input immediately.
 * The host is still authoritative, so when a snapshot arrives describing tick T
 * and it disagrees with what we predicted, we:
 *
 *   1. rewind to our stored world state at tick T
 *   2. overwrite the tank states with the host's authoritative values
 *   3. replay our stored inputs from T up to the present
 *
 * The player never sees this. Their tank stays responsive, and the correction
 * lands in the past.
 *
 * The reason this is affordable at all is that the sim is deterministic and the
 * world is small -- see cloneWorld in sim.ts. The reason it is *correct* is the
 * deterministic trig in math.ts: replaying inputs has to reproduce the same
 * trajectory the host computed, or every replay would introduce fresh drift.
 */

import { cloneWorld, step, type WorldState } from '../sim.js';
import { dcos, dsin, wrapAngle } from '../math.js';
import { TICK_HZ } from '../tuning.js';
import { emptyInput, type TankInput } from '../types.js';
import {
  MsgType,
  NetEvent,
  Reader,
  Writer,
  readShellSpawn,
  readSnapshot,
  writeInput,
} from './protocol.js';
import type { PeerId, Transport } from './transport.js';

/**
 * How many ticks of history to keep. At 60Hz this is one second, comfortably
 * more than the worst plausible BLE round trip plus a retransmit.
 */
const HISTORY_TICKS = 64;

/**
 * Position error we tolerate before rewinding. Snapshots quantise to 1/128 of
 * a tile, so anything at or below that is quantisation noise, not real
 * disagreement -- rewinding on it would rewind constantly for no reason.
 */
const RECONCILE_EPSILON = 1 / 64;

interface HistoryEntry {
  tick: number;
  world: WorldState;
  input: TankInput;
}

export class MatchClient {
  /** The locally predicted world. This is what the renderer draws. */
  world: WorldState;

  private history: HistoryEntry[] = [];
  private tickAccumulatorMs = 0;
  private pendingInput: TankInput = emptyInput();

  /** Diagnostics, surfaced in the debug HUD. */
  reconciles = 0;
  lastError = 0;
  snapshotsApplied = 0;
  snapshotsStale = 0;

  constructor(
    initial: WorldState,
    private transport: Transport,
    private hostId: PeerId,
    /** Which tank this client drives. */
    public localTankId: number,
  ) {
    this.world = initial;
    transport.setEvents({ onPacket: (from, data) => this.onPacket(from, data) });
  }

  setInput(input: TankInput): void {
    this.pendingInput = input;
  }

  update(elapsedMs: number): void {
    this.tickAccumulatorMs += elapsedMs;
    const tickMs = 1000 / TICK_HZ;
    let budget = 8;
    while (this.tickAccumulatorMs >= tickMs && budget-- > 0) {
      this.tickAccumulatorMs -= tickMs;
      this.stepOnce();
    }
    if (this.tickAccumulatorMs > tickMs * 8) this.tickAccumulatorMs = 0;
  }

  private stepOnce(): void {
    const input = { ...this.pendingInput };

    // Record the pre-step world so a correction for this tick can rewind to
    // exactly the state the host was describing.
    this.history.push({ tick: this.world.tick, world: cloneWorld(this.world), input });
    while (this.history.length > HISTORY_TICKS) this.history.shift();

    // Send our intent, then predict with it. Unreliable: a lost input frame is
    // replaced by the next one 16ms later, and the host reuses the last one it
    // has, so retransmitting stale intent would be worse than dropping it.
    const w = new Writer(16);
    writeInput(w, { tick: this.world.tick, ...input });
    this.transport.send(this.hostId, w.finish(), false);

    step(this.world, new Map([[this.localTankId, input]]));
  }

  private onPacket(from: PeerId, data: Uint8Array): void {
    if (from !== this.hostId) return;
    const r = new Reader(data);
    const type = r.u8();

    if (type === MsgType.Snapshot) {
      this.applySnapshot(r);
    } else if (type === MsgType.Event) {
      this.applyEvent(r);
    }
  }

  private applySnapshot(r: Reader): void {
    const snap = readSnapshot(r);

    // Recover the full tick from the 16-bit wire value using our own clock.
    const tick = this.expandTick(snap.tick);

    const idx = this.history.findIndex((h) => h.tick === tick);

    // A snapshot can describe the tick we are currently sitting on, which is
    // not in the ring yet -- entries are pushed as each tick begins, so the
    // present tick only lands in history once we step past it. That is the
    // normal case whenever link latency is near zero (loopback, or two players
    // sharing one device), so treat the live world as the rewind base rather
    // than discarding every snapshot and never reconciling at all.
    const base = idx === -1 ? (tick === this.world.tick ? this.world : null) : this.history[idx].world;
    if (!base) {
      // Older than our history, or from the future. Either way we cannot
      // rewind to it. Applying it directly would teleport the player.
      this.snapshotsStale++;
      return;
    }
    this.snapshotsApplied++;

    // How far did we drift on our own tank?
    const predicted = base.tanks.find((t) => t.id === this.localTankId);
    const authoritative = snap.tanks.find((t) => t.id === this.localTankId);
    let error = 0;
    if (predicted && authoritative) {
      const dx = predicted.x - authoritative.x;
      const dy = predicted.y - authoritative.y;
      error = Math.sqrt(dx * dx + dy * dy);
    }
    this.lastError = error;

    // Remote tanks are always taken from the host -- we do not predict them,
    // so there is nothing to preserve. Our own tank is only corrected when the
    // disagreement exceeds quantisation noise.
    const needsRewind = error > RECONCILE_EPSILON;

    const rewound = cloneWorld(base);
    for (const wire of snap.tanks) {
      const tank = rewound.tanks.find((t) => t.id === wire.id);
      if (!tank) continue;
      if (tank.id === this.localTankId && !needsRewind) continue;
      tank.x = wire.x;
      tank.y = wire.y;
      tank.bodyAngle = wire.bodyAngle;
      tank.turretAngle = wire.turretAngle;
      tank.alive = wire.alive;
    }

    if (needsRewind) this.reconciles++;

    // Replay everything we have done since, so the player's tank ends up where
    // their input says it should be -- just corrected. When the snapshot
    // described the live tick there is nothing after it to replay.
    this.world = rewound;
    if (idx === -1) return;
    for (let i = idx; i < this.history.length; i++) {
      const h = this.history[i];
      h.world = cloneWorld(this.world);
      step(this.world, new Map([[this.localTankId, h.input]]));
    }
  }

  private applyEvent(r: Reader): void {
    const kind = r.u8();

    if (kind === NetEvent.ShellSpawn) {
      const s = readShellSpawn(r);
      // Do not double-add a shell our own prediction already created.
      if (this.world.shells.some((x) => (x.id & 0xff) === s.shellId)) return;

      // The whole trajectory follows from here. This is the payoff for the
      // deterministic physics: ten bytes buys every bounce this shell will
      // ever make.
      const owner = this.world.tanks.find((t) => t.id === s.ownerId);
      const speed = this.shellSpeedFor(owner?.kind ?? 0);
      this.world.shells.push({
        id: s.shellId,
        ownerId: s.ownerId,
        team: owner?.team ?? 1,
        x: s.x,
        y: s.y,
        vx: dcos(s.angle) * speed,
        vy: dsin(s.angle) * speed,
        radius: 0.12,
        bouncesLeft: s.bounces,
        bornTick: this.expandTick(s.tick),
        selfArmDelay: 8,
      });
    } else if (kind === NetEvent.TankKilled) {
      r.u16();
      const victim = r.u8();
      const tank = this.world.tanks.find((t) => t.id === victim);
      if (tank) tank.alive = false;
    } else if (kind === NetEvent.BlockDestroyed) {
      const idx = r.u16();
      const cx = idx % this.world.arena.width;
      const cy = Math.floor(idx / this.world.arena.width);
      this.world.arena.set(cx, cy, 0);
    }
  }

  private shellSpeedFor(kind: number): number {
    // Kept local rather than importing TANK_SPECS wholesale so the client can
    // resolve a shell for a tank kind it does not otherwise model.
    switch (kind) {
      case 3:
      case 6:
        return 9.0; // rockets
      case 2:
      case 5:
        return 5.0; // ricochet
      default:
        return 5.5;
    }
  }

  /**
   * Rebuild a full tick from the 16 bits we transmit.
   *
   * The wire carries the low 16 bits, which wraps every ~18 minutes of play.
   * We assume the true value is the one nearest our own clock, which is correct
   * as long as we are within ~32000 ticks (9 minutes) of the host -- vastly
   * more slack than any real desync.
   */
  private expandTick(wireTick: number): number {
    const base = this.world.tick & ~0xffff;
    const candidates = [base + wireTick, base + wireTick - 0x10000, base + wireTick + 0x10000];
    let best = candidates[0];
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c - this.world.tick);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  /** Interpolation factor for smooth rendering between fixed ticks. */
  get frameAlpha(): number {
    return this.tickAccumulatorMs / (1000 / TICK_HZ);
  }
}

/** Exposed for the debug HUD. */
export function angleLerp(a: number, b: number, t: number): number {
  return wrapAngle(a + wrapAngle(b - a) * t);
}
