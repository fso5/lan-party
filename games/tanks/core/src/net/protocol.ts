/**
 * Wire protocol.
 *
 * Everything here exists to fit a real-time tank game through a Bluetooth LE
 * link, so the budget drives every decision. The target is one 20-player-tick
 * of traffic inside ~180 bytes, which is a single BLE write on iOS.
 *
 * The three things that make it fit:
 *
 *  1. Clients send input, never state. A full input frame is 4 bytes.
 *  2. Shells are never streamed. A shell's whole future is determined by its
 *     spawn position, angle and bounce count, so the host sends one 11-byte
 *     spawn event and every client simulates the trajectory locally with the
 *     identical deterministic physics. A shell that bounces around for eight
 *     seconds costs eleven bytes, once -- 9 bytes of payload behind a 2-byte
 *     message header. This is the single biggest saving in
 *     the protocol and it is the reason the deterministic-trig work in math.ts
 *     is not optional.
 *  3. Positions are quantised. Arenas are at most 32 tiles across, so 12 bits
 *     of position gives ~1/128th of a tile -- far finer than anyone can see --
 *     and angles get 8 bits, which is 1.4 degrees.
 *
 * Budget at 8 tanks, 15Hz snapshots: 8 * 6 bytes + 4 header = 52 bytes/snapshot
 * = ~780 B/s downstream per client. Comfortable.
 */

import { Reader, Writer } from '@lan-party/net';

export const PROTOCOL_VERSION = 2;

export enum MsgType {
  /** Host -> client, reliable. Full match setup: arena, teams, seed. */
  MatchStart = 1,
  /** Client -> host, unreliable, every tick. Input only. */
  Input = 2,
  /** Host -> client, unreliable, ~15Hz. Quantised tank states. */
  Snapshot = 3,
  /** Host -> client, reliable. Discrete things clients cannot predict. */
  Event = 4,
  /**
   * Either direction, reliable. Lobby membership and team changes.
   *
   * The lobby is the platform's, not this game's: its messages are defined in
   * @lan-party/lobby, which tags them with the same byte (`LOBBY_MSG`). The
   * value stays here so nothing in this game's protocol ever takes it.
   */
  Lobby = 5,
  /** Either direction. Timestamped for RTT estimation. */
  Ping = 6,
  Pong = 7,
}

/** Events that must arrive, because clients cannot derive them. */
export enum NetEvent {
  ShellSpawn = 1,
  MineSpawn = 2,
  MineExplode = 3,
  TankKilled = 4,
  BlockDestroyed = 5,
  RoundOver = 6,
}

/** World-space quantisation. Arenas are capped at 32x32 tiles. */
const POS_SCALE = 128; // 1/128 tile resolution
const ANGLE_SCALE = 256 / (Math.PI * 2);

/** Largest position the 12-bit field can carry: 4096/128 = 32 tiles. */
export const MAX_QUANT_POS = 0xfff;

export function quantPos(v: number): number {
  // Clamp, do not wrap. `& 0xfff` sends a tank at x=32.0 as x=0, teleporting it
  // across the arena instead of putting it slightly out of place. The arena cap
  // makes this unreachable today, so the failure would first appear the day
  // someone authors a wider map -- as an inexplicable teleport rather than
  // anything pointing at the protocol.
  const q = Math.round(v * POS_SCALE);
  return q < 0 ? 0 : q > MAX_QUANT_POS ? MAX_QUANT_POS : q;
}

export function dequantPos(q: number): number {
  return q / POS_SCALE;
}

/**
 * Largest world coordinate the wire can carry, in tiles.
 *
 * Exported so the map loader can refuse an arena the protocol cannot describe,
 * rather than each layer carrying its own copy of the number -- the two-sources
 * -of-truth shape that makes a constant look local and harmless right up until
 * they drift.
 *
 * `quantPos` clamps above this, which is the right call for a stray coordinate
 * and quietly disastrous for a whole arena: a tank at x=38.5 arrives as 31.99
 * on every client, six tiles from where the host has it, pinned there however
 * it drives, with locally simulated shells missing to match. Nothing about that
 * looks like a wire format running out of bits.
 */
export const MAX_WIRE_POS = MAX_QUANT_POS / POS_SCALE;

export function quantAngle(a: number): number {
  // Normalise to [0, 2PI) then to a byte.
  let n = a % (Math.PI * 2);
  if (n < 0) n += Math.PI * 2;
  return Math.round(n * ANGLE_SCALE) & 0xff;
}

export function dequantAngle(q: number): number {
  return q / ANGLE_SCALE;
}

/** One tank's input, packed into 4 bytes. Sent every tick by every client. */
export interface WireInput {
  tick: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  fire: boolean;
  layMine: boolean;
  /**
   * How many shots the client believes it has fired, modulo 8.
   *
   * The `fire` bit alone is not enough, and the reason is the one place where
   * the "a lost input is replaced by the next one 16ms later" argument does
   * not hold. That is true of the sticks: they are a continuous quantity and
   * the next sample supersedes the lost one. A shot is a discrete event, so a
   * dropped packet does not get superseded -- it is simply gone, while the
   * client has already drawn the shell. Measured on the Bluetooth profile: the
   * client held a shell the host had never fired on 22% of ticks, for up to
   * two seconds at a time, which is a shell's whole life.
   *
   * A count repeated in every packet heals itself. The host compares it with
   * what it has applied and fires the difference, so the shot survives as long
   * as any one of the next eight inputs arrives -- and at 60Hz, with shots at
   * least twelve ticks apart, that is seconds of total silence before it could
   * ever be ambiguous.
   */
  fireSeq?: number;
  /** The same, for mines. */
  mineSeq?: number;
}

export function writeInput(w: Writer, input: WireInput): void {
  w.u8(MsgType.Input);
  // Low 16 bits of the tick is ~18 minutes of play before wrapping, and the
  // host reconstructs the high bits from its own clock.
  w.u16(input.tick & 0xffff);
  // Sticks quantised to a signed byte each: 1/127 precision is well below the
  // resolution of a thumb on glass.
  w.i8(Math.round(clampUnit(input.moveX) * 127));
  w.i8(Math.round(clampUnit(input.moveY) * 127));
  w.i8(Math.round(clampUnit(input.aimX) * 127));
  w.i8(Math.round(clampUnit(input.aimY) * 127));
  // Two flags and two three-bit counters, all inside the byte the flags
  // already occupied -- the input frame does not grow.
  w.u8(
    (input.fire ? 1 : 0) |
      (input.layMine ? 2 : 0) |
      (((input.fireSeq ?? 0) & 7) << 2) |
      (((input.mineSeq ?? 0) & 7) << 5),
  );
}

export function readInput(r: Reader): WireInput {
  const tick = r.u16();
  const moveX = r.i8() / 127;
  const moveY = r.i8() / 127;
  const aimX = r.i8() / 127;
  const aimY = r.i8() / 127;
  const flags = r.u8();
  return {
    tick,
    moveX,
    moveY,
    aimX,
    aimY,
    fire: (flags & 1) !== 0,
    layMine: (flags & 2) !== 0,
    fireSeq: (flags >> 2) & 7,
    mineSeq: (flags >> 5) & 7,
  };
}

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** One tank in a snapshot: 6 bytes. */
export interface WireTank {
  id: number;
  x: number;
  y: number;
  bodyAngle: number;
  turretAngle: number;
  alive: boolean;
}

/**
 * Pack a snapshot.
 *
 * Layout per tank: [id:4|alive:1|xHi:3][xLo:8][yHi:4 in high nibble | ...]
 * -- rather than bit-packing across byte boundaries, which is error-prone and
 * saves only a byte per tank here, we use a byte-aligned 6-byte record:
 *
 *   u8  id (4 bits) | alive (1 bit) | reserved (3 bits)
 *   u16 x quantised, 12 bits used
 *   u16 y quantised, 12 bits used  -- packed together as 3 bytes
 *   u8  bodyAngle
 *   u8  turretAngle
 */
/**
 * How many tanks the wire can tell apart.
 *
 * A tank id is four bits, and the same four bits name a shell's and a mine's
 * owner. Unchecked, all three would mask on the way out and tank 16 would go
 * out as tank 0: two tanks drawn on top of each other, kills credited to the
 * wrong player, and a shell that passes through its real owner while arming
 * against a stranger. Nothing about that resembles running out of bits, so all
 * three refuse instead -- see `refuseUnnameableTank`.
 *
 * Sixteen against the eight `MAX_LOBBY_SLOTS` allows, so there is real headroom.
 * Measured across every shipped map, the largest roster any host here can build
 * is 8, and the two halves of that are further apart than they look:
 *
 *     versus   8   a full lobby on eight spawns, with no bots at all
 *     mission  4   one spawn plus three authored enemies
 *
 * An earlier version of this said "eight tanks counting authored enemies",
 * which reads as though the enemies were part of the eight. They are not -- the
 * maps that carry them seat one player and top out at four.
 *
 * It is named here because it is the ceiling any future seat-cap rise runs into,
 * and a number nobody has written down is one nobody checks.
 */
export const MAX_WIRE_TANKS = 16;

/**
 * Refuse loudly rather than mask and hand back a packet that is well-formed and
 * wrong.
 *
 * Shared by the three writers that pack a tank id into four bits, because they
 * are one rule rather than three: a shell's and a mine's `ownerId` is a
 * `tank.id`, from the same roster and the same id space the snapshot carries.
 * Guarding only the snapshot -- which is what this file did for a while -- fails
 * in the worse direction of the two. A renumbered tank in a snapshot is visible
 * the moment anyone looks at the arena; a renumbered shell owner is a kill
 * credited to a stranger, which looks like a scoring bug.
 *
 * `what` names the field, so the error points at the writer that refused rather
 * than at a number with no home.
 */
function refuseUnnameableTank(id: number, what: string): void {
  if (id >= MAX_WIRE_TANKS || id < 0) {
    throw new Error(
      `${what} ${id} cannot be sent -- the wire names at most ${MAX_WIRE_TANKS} tanks (0..${MAX_WIRE_TANKS - 1})`,
    );
  }
}

export function writeSnapshot(w: Writer, tick: number, tanks: WireTank[]): void {
  w.u8(MsgType.Snapshot);
  w.u16(tick & 0xffff);
  w.u8(tanks.length);
  for (const t of tanks) {
    refuseUnnameableTank(t.id, 'tank id');
    const qx = quantPos(t.x);
    const qy = quantPos(t.y);
    w.u8((t.id & 0x0f) | (t.alive ? 0x10 : 0));
    // Two 12-bit values across three bytes.
    w.u8(qx & 0xff);
    w.u8(((qx >> 8) & 0x0f) | ((qy & 0x0f) << 4));
    w.u8((qy >> 4) & 0xff);
    w.u8(quantAngle(t.bodyAngle));
    w.u8(quantAngle(t.turretAngle));
  }
}

export function readSnapshot(r: Reader): { tick: number; tanks: WireTank[] } {
  const tick = r.u16();
  const count = r.u8();
  const tanks: WireTank[] = [];
  for (let i = 0; i < count; i++) {
    const idByte = r.u8();
    const b0 = r.u8();
    const b1 = r.u8();
    const b2 = r.u8();
    const qx = b0 | ((b1 & 0x0f) << 8);
    const qy = ((b1 >> 4) & 0x0f) | (b2 << 4);
    tanks.push({
      id: idByte & 0x0f,
      alive: (idByte & 0x10) !== 0,
      x: dequantPos(qx),
      y: dequantPos(qy),
      bodyAngle: dequantAngle(r.u8()),
      turretAngle: dequantAngle(r.u8()),
    });
  }
  return { tick, tanks };
}

/**
 * A shell spawn. Eight bytes buys the entire trajectory, however long it
 * bounces around, because the receiving client simulates it with the same
 * deterministic physics the host used.
 */
/**
 * Largest bounce count the spawn's packed byte can carry.
 *
 * Two bits, sharing a byte with the four-bit owner id. Named rather than left
 * as a bare `0x03` in three places because the failure if a shell type ever
 * exceeds it is silent and does not look like a protocol problem: the count is
 * masked on the way out, so a four-bounce shell arrives as a rocket and dies
 * on the first wall it meets while the host's copy carries on ricocheting.
 * What anyone would see is a shell that vanishes mid-flight on one phone and
 * kills someone on another.
 *
 * `every shell profile and player slot fits the bits the wire gives it` in the
 * protocol tests fails the build instead. The packed byte has two spare bits if
 * a shell ever needs more than three, so widening this is a one-line change
 * plus the mask.
 */
export const MAX_WIRE_BOUNCES = 0x03;

/**
 * How many entities the wire can tell apart before ids start repeating.
 *
 * A shell's and a mine's id is two bytes, and `world.nextEntityId` is a
 * counter that never resets -- so `host.ts` truncates, and every 65536th spawn
 * reuses a number. That is fine as long as the entity holding it is already
 * dead, which is what makes this a margin rather than a bug.
 *
 * Spend the margin and the failure is not a duplicate on screen. `replaySpawns`
 * in client.ts skips a spawn whose id is already live, so of two live shells
 * sharing an id the second is simply not put back after a rewind: it is lethal
 * on the host and invisible on the phone. Rollback happens constantly, so this
 * would be a shell that vanishes at 45ms of latency and not at 5.
 *
 * It was one byte until shells started destroying each other (protocol v2).
 * `entity-ids.test.ts` runs ten minutes of the busiest match the game allows
 * and reports the worst churn a live entity sees: 172 of 256 before, and 294
 * after -- shells that meet in mid-air come back sooner, so tanks refire
 * sooner and ids go twice as fast. That run found live entities sharing a
 * byte. Two bytes cost one more per spawn event and leave the margin at well
 * over a hundredfold.
 */
export const MAX_WIRE_ENTITY_IDS = 65536;

export interface WireShellSpawn {
  shellId: number;
  ownerId: number;
  x: number;
  y: number;
  angle: number;
  bounces: number;
  tick: number;
}

export function writeShellSpawn(w: Writer, s: WireShellSpawn): void {
  refuseUnnameableTank(s.ownerId, 'shell owner id');
  w.u8(MsgType.Event);
  w.u8(NetEvent.ShellSpawn);
  w.u16(s.tick & 0xffff);
  w.u16(s.shellId & 0xffff);
  w.u8((s.ownerId & 0x0f) | ((s.bounces & MAX_WIRE_BOUNCES) << 4));
  const qx = quantPos(s.x);
  const qy = quantPos(s.y);
  w.u8(qx & 0xff);
  w.u8(((qx >> 8) & 0x0f) | ((qy & 0x0f) << 4));
  w.u8((qy >> 4) & 0xff);
  w.u8(quantAngle(s.angle));
}

export function readShellSpawn(r: Reader): WireShellSpawn {
  const tick = r.u16();
  const shellId = r.u16();
  const packed = r.u8();
  const b0 = r.u8();
  const b1 = r.u8();
  const b2 = r.u8();
  const qx = b0 | ((b1 & 0x0f) << 8);
  const qy = ((b1 >> 4) & 0x0f) | (b2 << 4);
  return {
    tick,
    shellId,
    ownerId: packed & 0x0f,
    bounces: (packed >> 4) & MAX_WIRE_BOUNCES,
    x: dequantPos(qx),
    y: dequantPos(qy),
    angle: dequantAngle(r.u8()),
  };
}

/**
 * A mine being laid.
 *
 * Like a shell spawn, this buys the mine's whole life in one message: it never
 * moves, and both its arming delay and its fuse are fixed offsets from the tick
 * it was laid on, so a client that knows where and when can run the rest of it
 * itself.
 *
 * There is no matching explode message, and NetEvent.MineExplode stays
 * reserved. A mine goes off on its fuse -- identical arithmetic on both sides
 * -- or when a tank that did not lay it drives into it, and the client is
 * working from the host's own tank positions, so the worst disagreement is a
 * tick or two on the trigger. Both sides then converge on the mine being gone,
 * which is the only state that persists.
 */
export interface WireMineSpawn {
  mineId: number;
  ownerId: number;
  x: number;
  y: number;
  /** The tick it was laid on -- not the tick this message was sent. */
  tick: number;
}

export function writeMineSpawn(w: Writer, m: WireMineSpawn): void {
  refuseUnnameableTank(m.ownerId, 'mine owner id');
  w.u8(MsgType.Event);
  w.u8(NetEvent.MineSpawn);
  w.u16(m.tick & 0xffff);
  w.u16(m.mineId & 0xffff);
  w.u8(m.ownerId & 0x0f);
  const qx = quantPos(m.x);
  const qy = quantPos(m.y);
  w.u8(qx & 0xff);
  w.u8(((qx >> 8) & 0x0f) | ((qy & 0x0f) << 4));
  w.u8((qy >> 4) & 0xff);
}

export function readMineSpawn(r: Reader): WireMineSpawn {
  const tick = r.u16();
  const mineId = r.u16();
  const ownerId = r.u8() & 0x0f;
  const b0 = r.u8();
  const b1 = r.u8();
  const b2 = r.u8();
  const qx = b0 | ((b1 & 0x0f) << 8);
  const qy = ((b1 >> 4) & 0x0f) | (b2 << 4);
  return { tick, mineId, ownerId, x: dequantPos(qx), y: dequantPos(qy) };
}

/**
 * Match setup.
 *
 * Sent reliably, once, when a client joins. It carries everything needed to
 * rebuild the host's world locally: which arena, the RNG seed, and the roster
 * in the order the host created it.
 *
 * Order is what matters most here. Tank ids are assigned by position during
 * createWorld, so a client that builds its roster in a different order ends up
 * with correct-looking tanks under the wrong ids, and every subsequent snapshot
 * silently applies to the wrong tank.
 */
export interface WireMatchStart {
  mapId: number;
  seed: number;
  /**
   * The host's tick when it sent this. The client uses it to start its clock
   * ahead of the host rather than at zero -- see MatchClient for why running
   * behind the host makes every snapshot undeliverable.
   */
  hostTick: number;
  /** Tank id this client controls. */
  yourTankId: number;
  /** Player slots, in host creation order. */
  players: { team: number; spawnIndex: number }[];
  /** AI tanks, in host creation order, appended after the players. */
  bots: { kind: number; team: number; spawnIndex: number }[];
}

export function writeMatchStart(w: Writer, m: WireMatchStart): void {
  // Tank ids are creation order over players then bots, so this roster decides
  // the id space every later snapshot has to fit into. Both sides of this
  // message would accept a larger one; the failure would arrive one tick later,
  // as `writeSnapshot` refusing a tank id, on the host, mid-match, with the
  // arena already built and everyone already in it. Refusing here puts it at
  // the moment the roster was assembled, which is the moment it can be fixed.
  const tanks = m.players.length + m.bots.length;
  if (tanks > MAX_WIRE_TANKS) {
    throw new Error(
      `match starts with ${tanks} tanks (${m.players.length} players, ${m.bots.length} bots), over the ${MAX_WIRE_TANKS} the wire can name -- the first snapshot would throw instead`,
    );
  }
  w.u8(MsgType.MatchStart);
  w.u8(PROTOCOL_VERSION);
  w.u16(m.mapId);
  w.u32(m.seed);
  w.u16(m.hostTick & 0xffff);
  w.u8(m.yourTankId);
  w.u8(m.players.length);
  for (const p of m.players) w.u8(p.team).u8(p.spawnIndex);
  w.u8(m.bots.length);
  for (const b of m.bots) w.u8(b.kind).u8(b.team).u8(b.spawnIndex);
}

export function readMatchStart(r: Reader): WireMatchStart {
  const version = r.u8();
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`protocol version mismatch: host speaks ${version}, we speak ${PROTOCOL_VERSION}`);
  }
  const mapId = r.u16();
  const seed = r.u32();
  const hostTick = r.u16();
  const yourTankId = r.u8();

  const players: { team: number; spawnIndex: number }[] = [];
  const playerCount = r.u8();
  for (let i = 0; i < playerCount; i++) players.push({ team: r.u8(), spawnIndex: r.u8() });

  const bots: { kind: number; team: number; spawnIndex: number }[] = [];
  const botCount = r.u8();
  for (let i = 0; i < botCount; i++) bots.push({ kind: r.u8(), team: r.u8(), spawnIndex: r.u8() });

  return { mapId, seed, hostTick, yourTankId, players, bots };
}

/**
 * Round result.
 *
 * Sent reliably, because a client cannot derive it. The scoreboard rides along
 * rather than being recomputed locally: match state deliberately lives outside
 * `WorldState` (see rules.ts), so a client replaying its history during
 * reconciliation would otherwise award and un-award rounds as it re-simulates.
 */
export interface WireRoundOver {
  /** Winning team, or DRAW. */
  winner: number;
  /** Host tick the next round begins. Meaningless once `matchOver` is set. */
  resumeAtTick: number;
  scores: { team: number; score: number }[];
  /**
   * This was the last round.
   *
   * Sent rather than derived: a client would need `roundsToWin` to work it out,
   * and a client that guesses wrong either announces a winner mid-match or
   * leaves everyone waiting for a round that is never coming.
   */
  matchOver: boolean;
}

/** DRAW is -1 in memory; it travels as 0xff because the field is a byte. */
const WIRE_DRAW = 0xff;

export function writeRoundOver(w: Writer, r: WireRoundOver): void {
  w.u8(MsgType.Event).u8(NetEvent.RoundOver);
  w.u8(r.winner < 0 ? WIRE_DRAW : r.winner);
  w.u16(r.resumeAtTick & 0xffff);
  w.u8(r.matchOver ? 1 : 0);
  w.u8(r.scores.length);
  for (const s of r.scores) w.u8(s.team).u8(s.score);
}

export function readRoundOver(r: Reader): WireRoundOver {
  const raw = r.u8();
  const winner = raw === WIRE_DRAW ? -1 : raw;
  const resumeAtTick = r.u16();
  const matchOver = r.u8() !== 0;
  const count = r.u8();
  const scores: { team: number; score: number }[] = [];
  for (let i = 0; i < count; i++) scores.push({ team: r.u8(), score: r.u8() });
  return { winner, resumeAtTick, scores, matchOver };
}

/** Estimated bytes/sec downstream to one client, for budget checks in tests. */
export function estimateDownstreamBps(tankCount: number, snapshotHz: number): number {
  const snapshotBytes = 4 + tankCount * 6;
  return snapshotBytes * snapshotHz;
}
