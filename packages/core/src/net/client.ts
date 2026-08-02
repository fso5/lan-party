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
  readRoundOver,
  readShellSpawn,
  readSnapshot,
  writeInput,
  type WireRoundOver,
  type WireTank,
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

/**
 * How far ahead of the host the client runs, in ticks.
 *
 * This is the least obvious requirement in the whole netcode. The client must
 * be *ahead*, not merely in sync: a snapshot describes tick T, and the client
 * can only apply it if T is still in its history ring -- that is, if the client
 * has already simulated past T. Start the client at tick 0 at the same moment
 * as the host and it sits permanently behind by the one-way latency, every
 * snapshot refers to a tick it has not reached, and reconciliation silently
 * never happens.
 *
 * 10 ticks is ~165ms, which covers a bad Bluetooth link's one-way delay plus
 * jitter. The cost is that your own input takes that long to reach the host,
 * but you never see it -- prediction shows you the result immediately.
 */
const CLIENT_LEAD_TICKS = 10;

/**
 * Consecutive undeliverable snapshots before we force a resync.
 *
 * Clocks drift, phones suspend, a device wedges for a second. Without this the
 * client would keep predicting happily against a host it can no longer hear
 * corrections from, and the two would diverge without any visible error.
 */
const RESYNC_AFTER_STALE = 25;

interface HistoryEntry {
  tick: number;
  world: WorldState;
  input: TankInput;
}

export { CLIENT_LEAD_TICKS };

export class MatchClient {
  /** The locally predicted world. This is what the renderer draws. */
  world: WorldState;

  private history: HistoryEntry[] = [];
  private tickAccumulatorMs = 0;
  private pendingInput: TankInput = emptyInput();

  /**
   * Latest round result from the host, or null before any round has ended.
   * This is the client's whole view of the scoreboard -- it is told, never
   * calculated, so a reconciliation replay cannot disturb it.
   */
  lastRound: WireRoundOver | null = null;

  /** Diagnostics, surfaced in the debug HUD. */
  reconciles = 0;
  lastError = 0;
  snapshotsApplied = 0;
  snapshotsStale = 0;
  resyncs = 0;
  private consecutiveStale = 0;

  constructor(
    initial: WorldState,
    private transport: Transport,
    private hostId: PeerId,
    /** Which tank this client drives. */
    public localTankId: number,
  ) {
    this.world = initial;
    transport.setEvents({ onPacket: (from, data) => this.handlePacket(from, data) });
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

  /**
   * Public so an embedder can own the transport's event wiring and forward
   * here. The host may send messages this class does not handle -- a match
   * restart, lobby changes -- and if MatchClient monopolised onPacket those
   * would be silently dropped by whoever is embedding it.
   */
  handlePacket(from: PeerId, data: Uint8Array): void {
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
      this.consecutiveStale++;

      // Persistently undeliverable means our clock has drifted out of the
      // window entirely -- keep predicting and we diverge from the host with
      // no visible symptom until someone dies to a shell they never saw. Take
      // the snapshot as ground truth and restart our clock ahead of it.
      if (this.consecutiveStale >= RESYNC_AFTER_STALE) this.resyncTo(snap, tick);
      return;
    }
    this.consecutiveStale = 0;
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

  /**
   * Adopt a snapshot wholesale and restart our clock ahead of it.
   *
   * Used only when we have gone deaf to corrections for long enough that
   * predicting further is worse than a visible jump. History is discarded --
   * it describes a timeline the host never agreed with.
   */
  private resyncTo(snap: { tanks: WireTank[] }, tick: number): void {
    for (const wire of snap.tanks) {
      const tank = this.world.tanks.find((t) => t.id === wire.id);
      if (!tank) continue;
      tank.x = wire.x;
      tank.y = wire.y;
      tank.bodyAngle = wire.bodyAngle;
      tank.turretAngle = wire.turretAngle;
      tank.alive = wire.alive;
    }
    // Shells in flight cannot be recovered from a snapshot -- they are not in
    // it. Drop them rather than leave ghosts the host does not know about; the
    // next spawn event repopulates.
    this.world.shells.length = 0;
    this.world.tick = tick + CLIENT_LEAD_TICKS;
    this.history.length = 0;
    this.consecutiveStale = 0;
    this.resyncs++;
  }

  private applyEvent(r: Reader): void {
    const kind = r.u8();

    if (kind === NetEvent.ShellSpawn) {
      const s = readShellSpawn(r);
      /*
       * Do not double-add a shell our own prediction already created.
       *
       * Matched on owner as well as id, because the id on the wire is only the
       * low eight bits and a stranger's shell can land on the same byte. The
       * shells this can legitimately duplicate are the ones we predicted, and
       * we only ever predict our own -- so anyone else's spawn is never a
       * duplicate, whatever byte it arrives with.
       *
       * Dropping a spawn is not cosmetic: clients simulate shells locally from
       * this event, so a shell dropped here exists on the host, kills you
       * there, and is never drawn on your phone.
       */
      if (
        this.world.shells.some((x) => (x.id & 0xff) === s.shellId && x.ownerId === s.ownerId)
      ) {
        return;
      }

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
    } else if (kind === NetEvent.RoundOver) {
      // Taken from the host verbatim rather than derived. Deriving it here
      // would re-run during every reconciliation replay and score the same
      // round repeatedly -- which is exactly why match state lives outside
      // WorldState. See rules.ts.
      this.lastRound = readRoundOver(r);
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
