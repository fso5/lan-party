/**
 * Authoritative host.
 *
 * The host runs the only simulation that counts. Clients predict locally, but
 * when they disagree with the host, the host wins.
 *
 * It sends two kinds of traffic, and the split is what keeps us inside the BLE
 * budget:
 *
 *   Snapshots (unreliable, 15Hz) -- quantised tank positions. Deliberately
 *   unreliable: a lost snapshot is superseded by a fresher one 66ms later, and
 *   retransmitting stale positions would spend bandwidth to deliver data that
 *   is already wrong.
 *
 *   Events (reliable) -- shell spawns, kills, terrain damage. These cannot be
 *   dropped because clients cannot re-derive them, and a client that misses a
 *   shell spawn has an invisible shell flying at it.
 */

import { datan2 } from '../math.js';
import { cloneWorld, step, type WorldState } from '../sim.js';
import { TICK_HZ } from '../tuning.js';
import { emptyInput, EventKind, type TankInput } from '../types.js';
import {
  MsgType,
  NetEvent,
  Reader,
  Writer,
  readInput,
  writeShellSpawn,
  writeSnapshot,
} from './protocol.js';
import type { PeerId, Transport } from './transport.js';

/** Snapshot rate. 15Hz is the sweet spot: interpolation covers the gaps. */
export const SNAPSHOT_HZ = 15;
const SNAPSHOT_INTERVAL = Math.round(TICK_HZ / SNAPSHOT_HZ);

/**
 * How long the host will keep re-using a client's last input when nothing new
 * arrives. Beyond this the tank is treated as idle rather than continuing to
 * drive on stale input into a wall.
 */
const INPUT_STALE_TICKS = 20;

interface ClientSlot {
  peerId: PeerId;
  tankId: number;
  lastInput: TankInput;
  lastInputTick: number;
  /** Highest tick seen from this client, for reordering. */
  highestTick: number;
}

export class MatchHost {
  private clients = new Map<PeerId, ClientSlot>();
  private tickAccumulatorMs = 0;
  private pendingEvents: Uint8Array[] = [];
  private localInput: TankInput = emptyInput();

  /**
   * The tank the person running the host is driving, or -1 for a dedicated
   * host with no player. On a phone the host is a player too -- there is no
   * server -- so without this their own tank would sit inert while everyone
   * else moved.
   */
  localTankId = -1;

  constructor(
    public world: WorldState,
    private transport: Transport,
  ) {
    transport.setEvents({
      onPacket: (from, data) => this.handlePacket(from, data),
      onPeerLeave: (peerId) => this.clients.delete(peerId),
    });
  }

  /** Input for the host's own tank, set each frame by the local game loop. */
  setLocalInput(input: TankInput): void {
    this.localInput = input;
  }

  /** Seat a client in a tank. Returns the tank id it now controls. */
  addClient(peerId: PeerId, tankId: number): void {
    this.clients.set(peerId, {
      peerId,
      tankId,
      lastInput: emptyInput(),
      lastInputTick: 0,
      highestTick: -1,
    });
  }

  /**
   * Public so an embedder can own the transport's event wiring and forward
   * here -- the same reason MatchClient exposes it. A lobby needs to see peers
   * connect and disconnect, and if MatchHost monopolised onPacket those events
   * would be silently swallowed.
   */
  handlePacket(from: PeerId, data: Uint8Array): void {
    const r = new Reader(data);
    const type = r.u8();
    if (type !== MsgType.Input) return;

    const slot = this.clients.get(from);
    if (!slot) return;

    const input = readInput(r);

    // Jitter reorders packets, so an input that arrives after a newer one is
    // stale and must be discarded rather than overwriting fresher intent.
    // Compare on the 16-bit wire tick with wraparound handling.
    const delta = (input.tick - slot.highestTick) & 0xffff;
    if (slot.highestTick >= 0 && (delta === 0 || delta > 0x8000)) return;

    slot.highestTick = input.tick;
    slot.lastInput = {
      moveX: input.moveX,
      moveY: input.moveY,
      aimX: input.aimX,
      aimY: input.aimY,
      fire: input.fire,
      layMine: input.layMine,
    };
    slot.lastInputTick = this.world.tick;
  }

  /**
   * Advance by real elapsed time, stepping in whole fixed ticks.
   *
   * Never scale the simulation by a variable dt. Determinism is what lets
   * clients simulate shells locally, and a variable timestep destroys it.
   */
  update(elapsedMs: number): void {
    this.tickAccumulatorMs += elapsedMs;
    const tickMs = 1000 / TICK_HZ;

    // Cap catch-up so a stalled frame cannot produce a hundred-tick spiral.
    let budget = 8;
    while (this.tickAccumulatorMs >= tickMs && budget-- > 0) {
      this.tickAccumulatorMs -= tickMs;
      this.stepOnce();
    }
    if (this.tickAccumulatorMs > tickMs * 8) this.tickAccumulatorMs = 0;
  }

  private stepOnce(): void {
    const inputs = new Map<number, TankInput>();
    for (const slot of this.clients.values()) {
      const age = this.world.tick - slot.lastInputTick;
      inputs.set(slot.tankId, age > INPUT_STALE_TICKS ? emptyInput() : slot.lastInput);
    }
    // The host's own tank has no network round trip -- its input applies on the
    // very tick it was produced, which is the one genuine advantage of hosting.
    if (this.localTankId >= 0) inputs.set(this.localTankId, this.localInput);

    step(this.world, inputs);

    // Any shell born this tick becomes a spawn event. Clients simulate the
    // trajectory themselves from here -- we never send its position again.
    //
    // Identify them by bornTick rather than by walking ShellFired events: two
    // tanks can fire on the same tick, and pairing events to shells by array
    // position gets that wrong.
    for (const shell of this.world.shells) {
      if (shell.bornTick !== this.world.tick - 1) continue;
      // Note the position we send is post-movement: step() advances a new
      // shell in the same tick it is fired. So the (position, angle) pair we
      // send is the shell's state at world.tick, not at bornTick, and the
      // client must start its local simulation from world.tick to match.
      const w = new Writer(16);
      writeShellSpawn(w, {
        shellId: shell.id & 0xff,
        ownerId: shell.ownerId,
        x: shell.x,
        y: shell.y,
        angle: datan2(shell.vy, shell.vx),
        bounces: shell.bouncesLeft,
        tick: this.world.tick,
      });
      this.pendingEvents.push(w.finish());
    }

    for (const ev of this.world.events) {
      if (ev.kind === EventKind.TankDestroyed) {
        const w = new Writer(8);
        w.u8(MsgType.Event).u8(NetEvent.TankKilled).u16(this.world.tick & 0xffff).u8(ev.a).u8(ev.b);
        this.pendingEvents.push(w.finish());
      } else if (ev.kind === EventKind.BlockDestroyed) {
        const w = new Writer(8);
        w.u8(MsgType.Event).u8(NetEvent.BlockDestroyed).u16(ev.a & 0xffff);
        this.pendingEvents.push(w.finish());
      }
    }

    this.flushEvents();

    if (this.world.tick % SNAPSHOT_INTERVAL === 0) this.sendSnapshot();
  }

  private flushEvents(): void {
    for (const e of this.pendingEvents) this.transport.broadcast(e, true);
    this.pendingEvents.length = 0;
  }

  private sendSnapshot(): void {
    const w = new Writer(256);
    writeSnapshot(
      w,
      this.world.tick,
      this.world.tanks.map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        bodyAngle: t.bodyAngle,
        turretAngle: t.turretAngle,
        alive: t.alive,
      })),
    );
    const buf = w.finish();
    if (buf.length > this.transport.maxPayload) {
      // Splitting a snapshot is possible but means a client can render half a
      // frame of new positions and half a frame of old. Better to notice the
      // arena is over-populated than to ship the tearing.
      throw new Error(
        `snapshot is ${buf.length}B, over the ${this.transport.maxPayload}B transport limit ` +
          `(${this.world.tanks.length} tanks)`,
      );
    }
    this.transport.broadcast(buf, false);
  }

  /** State a late-joining client needs. */
  snapshotForJoin(): WorldState {
    return cloneWorld(this.world);
  }
}
