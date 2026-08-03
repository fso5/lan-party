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
import { cloneWorld, killTank, step, tankById, type WorldState } from '../sim.js';
import {
  DEFAULT_RULES,
  DRAW,
  createMatch,
  updateMatch,
  standings,
  type MatchRules,
  type MatchState,
} from '../rules.js';
import { MINE_ARM_TICKS, TICK_HZ } from '../tuning.js';
import { emptyInput, EventKind, type TankInput } from '../types.js';
import {
  MsgType,
  NetEvent,
  Reader,
  Writer,
  readInput,
  writeMineSpawn,
  writeRoundOver,
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

/**
 * How long a departed player's tank is held before it is destroyed.
 *
 * Without this the tank simply stands there, alive, for ever: a round ends
 * when one team is left standing, and an abandoned tank keeps its team in the
 * count. Somebody's phone rings, they close the tab, and everyone else has to
 * go and shoot a statue to finish the round -- two statues around a maze if a
 * pair left, and a round that cannot end at all if the players still there are
 * all on one team.
 *
 * Not destroyed immediately, because phone WiFi drops for a second or two at a
 * time and the browser client reconnects on a backoff that tops out at five --
 * killing on the first missing packet would punish a hiccup with a death. Ten
 * seconds outlasts a blip and a couple of retries, and is short enough that
 * nobody is left wondering whether the game is broken.
 */
const ABANDON_TICKS = TICK_HZ * 10;

/**
 * How far behind a client's action count we are, given what we last applied.
 *
 * Modular, because the count is three bits on the wire, and capped, because a
 * client we have not heard from for a while should rejoin the fight rather
 * than empty its magazine into the room on the first packet back. Two is one
 * shot in flight plus the one being asked for.
 *
 * The cap does drop shots at the extreme, and it is worth knowing why before
 * anyone raises it. A client predicts its own shells, so its copies are born
 * on the tick it pressed the button while ours are born when the input reaches
 * us -- theirs are older, theirs expire first, and its shell allowance frees up
 * before ours does. Measured on the Bluetooth profile: on roughly two hundred
 * ticks of a thirty-second run the client had a free slot when we did not. So
 * a player holding the trigger down asks for shots slightly faster than we can
 * ever grant them, the debt climbs to the cap, and the excess is lost.
 *
 * Whether that matters depends entirely on how the trigger is used. Tapping it
 * twice a second, which is how the game is actually played, we fire every shot
 * asked for -- 18 drawn and 18 fired on a perfect link, 22 and 22 over
 * Bluetooth. Holding it down permanently, which took resurrecting both tanks
 * every tick to sustain, the client drew 74 and we fired 40.
 *
 * Raising the cap would convert those lost shots into late ones, arriving
 * after the player has stopped asking, and would bring back the magazine
 * emptying itself on reconnect. Left where it is deliberately.
 */
const MAX_OWED = 2;

export function catchUp(lastSeq: number, seq: number, owed: number): number {
  if (lastSeq < 0) return 0; // First packet: nothing owed, just take the mark.
  const delta = (seq - lastSeq) & 7;
  return Math.min(owed + delta, MAX_OWED);
}

interface ClientSlot {
  peerId: PeerId;
  tankId: number;
  lastInput: TankInput;
  lastInputTick: number;
  /** Highest tick seen from this client, for reordering. */
  highestTick: number;
  /** Last fire/mine count applied from this client, or -1 before the first. */
  lastFireSeq: number;
  lastMineSeq: number;
  /** Shots and mines this client has produced that we have not yet. */
  owedShots: number;
  owedMines: number;
}

export class MatchHost {
  private clients = new Map<PeerId, ClientSlot>();
  /** Tank id -> the tick its player left. See ABANDON_TICKS. */
  private abandoned = new Map<number, number>();
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

  /**
   * Rounds and scoring. Host-owned and host-only: clients are told the result
   * rather than deriving it, because a client replaying its input history
   * during reconciliation would re-run any locally-derived scoring and award
   * the same round several times.
   */
  readonly match: MatchState;

  /**
   * Builds the world for the next round. Supplied by the embedder, because
   * loading an arena is a content concern and the netcode has no business
   * knowing how maps are addressed.
   *
   * **The roster must be rebuilt in the same order every time.** Tank ids come
   * from creation order, so a round that seats players differently hands every
   * client a tank id belonging to somebody else.
   *
   * Without one, a match is a single round -- see `beginRound`.
   */
  roundBuilder: ((round: number) => WorldState) | null = null;

  /**
   * A new round's world is live. The embedder sends `MatchStart` from here so
   * clients rebuild against it; they cannot derive a new world on their own.
   */
  onRoundStart: ((world: WorldState, round: number) => void) | null = null;

  /**
   * The match is decided. Fired once, on the tick it happens.
   *
   * Without it an embedder has no edge to react to -- the phase simply becomes
   * `finished` and stays there while the world keeps stepping, so a screen
   * rendering the match shows a dead arena for ever with no way out. Polling
   * `match.phase` from a render loop is the alternative and it is worse: the
   * transition is one tick wide and the screen only redraws when React decides
   * to.
   */
  onMatchOver: ((winner: number) => void) | null = null;

  constructor(
    public world: WorldState,
    private transport: Transport,
    rules: MatchRules = DEFAULT_RULES,
  ) {
    // Seed the scoreboard from whoever is actually in the arena, so a lobby
    // that seated four players on four teams gets a four-way free-for-all and
    // one that seated them on two gets 2v2, with nothing here needing to know
    // which arrangement it was handed.
    this.match = createMatch(rules, [...new Set(world.tanks.map((t) => t.team))].sort((a, b) => a - b));

    transport.setEvents({
      onPacket: (from, data) => this.handlePacket(from, data),
      onPeerLeave: (peerId) => this.removeClient(peerId),
    });
  }

  /** Input for the host's own tank, set each frame by the local game loop. */
  setLocalInput(input: TankInput): void {
    this.localInput = input;
  }

  /** Seat a client in a tank. Returns the tank id it now controls. */
  addClient(peerId: PeerId, tankId: number): void {
    // Seating this tank again cancels its countdown, which is what makes a
    // reconnect survivable: the player comes back to the tank they left.
    this.abandoned.delete(tankId);
    this.clients.set(peerId, {
      peerId,
      tankId,
      lastInput: emptyInput(),
      lastInputTick: 0,
      highestTick: -1,
      lastFireSeq: -1,
      lastMineSeq: -1,
      owedShots: 0,
      owedMines: 0,
    });
  }

  /**
   * Unseat a client. Called automatically on `onPeerLeave`.
   *
   * Public because an embedder that owns dispatch replaces that handler, and
   * without this it has no way to reproduce the cleanup: the departed peer
   * keeps a slot, so `stepOnce` keeps feeding its tank stale-then-empty input
   * and the host keeps addressing snapshots to a phone that walked away.
   *
   * Idempotent -- a leave can arrive after an explicit removal.
   */
  removeClient(peerId: PeerId): void {
    const slot = this.clients.get(peerId);
    if (slot && !this.abandoned.has(slot.tankId)) {
      this.abandoned.set(slot.tankId, this.world.tick);
    }
    this.clients.delete(peerId);
  }

  /**
   * Destroy the tanks of players who left and did not come back.
   *
   * Through `killTank` rather than by setting `alive = false`, so it emits a
   * `TankDestroyed` the same as any other death: clients learn about it from
   * the event they already handle, and the explosion is drawn. Credited to the
   * tank itself, because there is no killer -- the player walked away.
   */
  private retireAbandoned(): void {
    if (this.abandoned.size === 0) return;
    for (const [tankId, leftAtTick] of this.abandoned) {
      if (this.world.tick - leftAtTick < ABANDON_TICKS) continue;
      const tank = tankById(this.world, tankId);
      if (tank?.alive) killTank(this.world, tank, tankId);
      this.abandoned.delete(tankId);
    }
  }

  /** Peers currently seated, for a lobby roster or a reconnect check. */
  hasClient(peerId: PeerId): boolean {
    return this.clients.has(peerId);
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
      // Firing is driven by the counters below, not by this bit. The bit says
      // "the trigger is down right now", which is the wrong question when the
      // packet carrying the shot may simply not have arrived.
      fire: false,
      layMine: false,
    };
    slot.lastInputTick = this.world.tick;

    // How many shots has this client produced that we have not? A count rather
    // than an edge, so a dropped input costs nothing: the next one carries the
    // same total. Capped, because a client that has been silent for a while
    // should rejoin the fight, not empty its magazine into the room.
    slot.owedShots = catchUp(slot.lastFireSeq, input.fireSeq ?? 0, slot.owedShots);
    slot.owedMines = catchUp(slot.lastMineSeq, input.mineSeq ?? 0, slot.owedMines);
    slot.lastFireSeq = input.fireSeq ?? 0;
    slot.lastMineSeq = input.mineSeq ?? 0;
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
      const base = age > INPUT_STALE_TICKS ? emptyInput() : slot.lastInput;
      // Spend one owed action per tick. The simulation still has the last word
      // -- its cooldown may refuse -- so the debt is only cleared below, when a
      // shell or mine actually appeared.
      inputs.set(slot.tankId, {
        ...base,
        fire: slot.owedShots > 0,
        layMine: slot.owedMines > 0,
      });
    }
    // The host's own tank has no network round trip -- its input applies on the
    // very tick it was produced, which is the one genuine advantage of hosting.
    if (this.localTankId >= 0) inputs.set(this.localTankId, this.localInput);

    step(this.world, inputs);

    // Runs after step() -- which clears `world.events` -- and before the loop
    // that turns those events into wire messages, so a retirement rides out on
    // the same tick it happens and counts toward this tick's scoring.
    this.retireAbandoned();

    // Any shell born this tick becomes a spawn event. Clients simulate the
    // trajectory themselves from here -- we never send its position again.
    //
    // Identify them by bornTick rather than by walking ShellFired events: two
    // tanks can fire on the same tick, and pairing events to shells by array
    // position gets that wrong.
    // Clear a client's debt only when the shot really happened. If our own
    // cooldown refused it, it stays owed and goes out on a later tick.
    for (const slot of this.clients.values()) {
      if (slot.owedShots > 0 &&
          this.world.shells.some((s) => s.ownerId === slot.tankId && s.bornTick === this.world.tick - 1)) {
        slot.owedShots--;
      }
      if (slot.owedMines > 0 &&
          this.world.mines.some((m) => m.ownerId === slot.tankId && m.armTick - MINE_ARM_TICKS === this.world.tick - 1)) {
        slot.owedMines--;
      }
    }

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

    // And any mine laid this tick, for the same reason: without this the only
    // mine a phone can see is its own, and an opponent's kills you off an
    // empty patch of floor.
    //
    // Dated by armTick for the same reason shells are dated by bornTick --
    // two tanks can lay on the same tick, and pairing MineLaid events to mines
    // by array position gets that wrong.
    for (const mine of this.world.mines) {
      const laidOn = mine.armTick - MINE_ARM_TICKS;
      if (laidOn !== this.world.tick - 1) continue;
      const w = new Writer(16);
      writeMineSpawn(w, {
        mineId: mine.id & 0xff,
        ownerId: mine.ownerId,
        x: mine.x,
        y: mine.y,
        tick: laidOn,
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

    // Scoring runs after the step, so this tick's deaths count toward it.
    const phaseBefore = this.match.phase;
    if (updateMatch(this.match, this.world)) {
      const w = new Writer(32);
      writeRoundOver(w, {
        winner: this.match.lastRoundWinner ?? -1,
        resumeAtTick: this.match.resumeAtTick,
        scores: standings(this.match),
        matchOver: this.match.phase === 'finished',
      });
      this.pendingEvents.push(w.finish());
    }

    // The intermission just elapsed, so a new round begins on this tick.
    if (phaseBefore === 'intermission' && this.match.phase === 'playing') {
      this.beginRound();
    }

    // Checked after beginRound, which can also finish a match when there is no
    // way to build another round.
    if (phaseBefore !== 'finished' && this.match.phase === 'finished') {
      this.onMatchOver?.(this.match.matchWinner ?? DRAW);
    }

    this.flushEvents();

    if (this.world.tick % SNAPSHOT_INTERVAL === 0) this.sendSnapshot();
  }

  /**
   * Start the next round on a fresh world.
   *
   * Without this the previous round's corpses are still lying there when the
   * intermission ends, so the very next tick decides the "new" round for
   * whoever won the last one -- and a best-of-three completes in about six
   * seconds without anybody playing. Rebuilding is not a nicety; a match is
   * incoherent without it.
   *
   * With no `roundBuilder` there is no way to produce a second world, so the
   * match is a single round and ends here. That is a truthful outcome rather
   * than the alternative, which is awarding every remaining round to the same
   * team for the same corpses.
   */
  private beginRound(): void {
    if (!this.roundBuilder) {
      this.match.phase = 'finished';
      this.match.matchWinner = this.match.lastRoundWinner;
      return;
    }

    const next = this.roundBuilder(this.match.round);

    // Carry the clock forward rather than restarting at zero. Ticks travel as
    // 16 bits and clients expand them against their own clock, so a counter
    // that jumps backwards between rounds makes every snapshot look ancient
    // until the client happens to resync.
    next.tick = this.world.tick + 1;
    this.world = next;

    // Events queued against the old world describe shells and blocks that no
    // longer exist. Sending them would spawn phantoms in the new round.
    this.pendingEvents.length = 0;

    // Countdowns belong to the tanks of the round that just ended. The next
    // round is built from a fresh roster, so a player who left is simply not
    // in it -- and carrying an id forward would retire whoever inherits it.
    this.abandoned.clear();

    // So do the action counts, for the same reason and with a sharper edge.
    //
    // A debt outstanding when the round ended -- a shot asked for on the tick
    // its tank died, which the simulation could never spend -- is fired the
    // moment the new round makes that tank alive again. Measured: a shell out
    // of a spawn point a hundred and seventy ticks into a round nobody had
    // touched the trigger in.
    //
    // The marks have to go too, and that is the commoner case. Embedders build
    // a fresh client for each round, because MatchStart is what tells them the
    // new world -- so the client's counter restarts at zero while ours still
    // holds the old value, and the difference between them is read as shots
    // owed. Setting the mark back to "unset" makes the first packet of the
    // round establish it again instead.
    for (const slot of this.clients.values()) {
      slot.lastFireSeq = -1;
      slot.lastMineSeq = -1;
      slot.owedShots = 0;
      slot.owedMines = 0;
    }

    this.onRoundStart?.(this.world, this.match.round);
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

  /**
   * A copy of the live world. Nothing calls this, and the name oversells it.
   *
   * It is not what a late-joining client needs, and reaching for it is how
   * someone will conclude that mid-match joining is solved. A joiner is handed
   * `MatchStart` -- map id, seed, roster -- and rebuilds the world from those,
   * which reproduces the arena as it was authored, not as it now stands. So it
   * arrives with every destroyed block back in place and no mines on the
   * ground, and nothing ever corrects either: snapshots carry tanks and
   * nothing else, and the events that reported that damage were sent once,
   * before it was listening.
   *
   * A WorldState cannot cross the wire, so this does not close that gap; it
   * would need fields on `MatchStart` for the terrain and the mines. Left
   * unbuilt on purpose. The only host that seats players today does it once,
   * at the start of a round, so nobody can join mid-match to be wrong about
   * the arena -- and building a protocol for a path that does not exist yet
   * means guessing at what it needs.
   */
  snapshotForJoin(): WorldState {
    return cloneWorld(this.world);
  }
}
