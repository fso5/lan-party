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
 *     spawn position, angle and bounce count, so the host sends one 10-byte
 *     spawn event and every client simulates the trajectory locally with the
 *     identical deterministic physics. A shell that bounces around for eight
 *     seconds costs ten bytes, once -- 8 bytes of payload behind a 2-byte
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

export const PROTOCOL_VERSION = 1;

export enum MsgType {
  /** Host -> client, reliable. Full match setup: arena, teams, seed. */
  MatchStart = 1,
  /** Client -> host, unreliable, every tick. Input only. */
  Input = 2,
  /** Host -> client, unreliable, ~15Hz. Quantised tank states. */
  Snapshot = 3,
  /** Host -> client, reliable. Discrete things clients cannot predict. */
  Event = 4,
  /** Either direction, reliable. Lobby membership and team changes. */
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

export function quantAngle(a: number): number {
  // Normalise to [0, 2PI) then to a byte.
  let n = a % (Math.PI * 2);
  if (n < 0) n += Math.PI * 2;
  return Math.round(n * ANGLE_SCALE) & 0xff;
}

export function dequantAngle(q: number): number {
  return q / ANGLE_SCALE;
}

/** Growable little-endian byte writer. */
export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }

  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  str(s: string): this {
    const enc = new TextEncoder().encode(s);
    this.u8(enc.length);
    return this.bytes(enc);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  get length(): number {
    return this.pos;
  }
}

/**
 * Thrown when a packet ends mid-field.
 *
 * A distinct type so callers can tell a malformed packet from a genuine bug in
 * their own parsing and drop the packet rather than tearing down the match.
 */
export class TruncatedPacketError extends Error {
  constructor(need: number, have: number, at: number) {
    super(`packet truncated: needed ${need} bytes at offset ${at}, ${have} remain`);
    this.name = 'TruncatedPacketError';
  }
}

/**
 * Little-endian byte reader that refuses to read past the end.
 *
 * Every read is bounds checked, and that is not defensive programming for its
 * own sake. Over BLE a truncated packet is a routine input, not an exotic one:
 * a fragment can be dropped, a write can be cut short at a renegotiated MTU,
 * and the peer on the other end is a phone whose radio stack we do not control.
 *
 * Unchecked, the two failure modes differ and the quiet one is worse.
 * `getUint16` past the end throws a `RangeError`, which at least announces
 * itself -- but `u8()` past the end returns `undefined`, and `undefined` flows
 * into the arithmetic that unpacks positions and angles, producing `NaN` tank
 * coordinates that propagate into the world with no error anywhere. A packet
 * that ends early should be dropped, not half-applied.
 */
export class Reader {
  private view: DataView;
  private pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new TruncatedPacketError(n, this.buf.length - this.pos, this.pos);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i8(): number {
    this.need(1);
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }

  bytes(n: number): Uint8Array {
    if (n < 0) throw new RangeError(`bytes(${n}): negative length`);
    this.need(n);
    const v = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  str(): string {
    // The length prefix comes off the wire, so it is attacker- and
    // corruption-controlled: bytes() must bounds check it rather than trust it.
    const n = this.u8();
    return new TextDecoder().decode(this.bytes(n));
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }
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
export function writeSnapshot(w: Writer, tick: number, tanks: WireTank[]): void {
  w.u8(MsgType.Snapshot);
  w.u16(tick & 0xffff);
  w.u8(tanks.length);
  for (const t of tanks) {
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
  w.u8(MsgType.Event);
  w.u8(NetEvent.ShellSpawn);
  w.u16(s.tick & 0xffff);
  w.u8(s.shellId & 0xff);
  w.u8((s.ownerId & 0x0f) | ((s.bounces & 0x03) << 4));
  const qx = quantPos(s.x);
  const qy = quantPos(s.y);
  w.u8(qx & 0xff);
  w.u8(((qx >> 8) & 0x0f) | ((qy & 0x0f) << 4));
  w.u8((qy >> 4) & 0xff);
  w.u8(quantAngle(s.angle));
}

export function readShellSpawn(r: Reader): WireShellSpawn {
  const tick = r.u16();
  const shellId = r.u8();
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
    bounces: (packed >> 4) & 0x03,
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
  w.u8(MsgType.Event);
  w.u8(NetEvent.MineSpawn);
  w.u16(m.tick & 0xffff);
  w.u8(m.mineId & 0xff);
  w.u8(m.ownerId & 0x0f);
  const qx = quantPos(m.x);
  const qy = quantPos(m.y);
  w.u8(qx & 0xff);
  w.u8(((qx >> 8) & 0x0f) | ((qy & 0x0f) << 4));
  w.u8((qy >> 4) & 0xff);
}

export function readMineSpawn(r: Reader): WireMineSpawn {
  const tick = r.u16();
  const mineId = r.u8();
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
 * Lobby.
 *
 * This is where "teams, one or many" is actually decided. The simulation keys
 * every hostility decision off `team`, so a lobby that can put eight players on
 * eight teams gets free-for-all, and one that puts them on two gets 4v4, with
 * no other code aware of the difference. Nothing here caps the team count below
 * the roster size on purpose.
 *
 * The host is authoritative. Clients *request* a team and the host answers with
 * a roster; a client never assumes its own request took. Two players tapping
 * the same team at once is normal, and the alternative -- optimistic local
 * team changes -- shows two phones disagreeing about who is on which side right
 * up until the match starts.
 */
export enum LobbyOp {
  /** Host -> everyone, reliable. The authoritative roster and settings. */
  Roster = 1,
  /** Host -> one client, reliable. Tells it which slot is itself. */
  Welcome = 2,
  /** Client -> host. "Seat me, this is my name." */
  Join = 3,
  /** Client -> host. "Put me on this team." */
  SetTeam = 4,
  /** Client -> host. Ready toggle. */
  SetReady = 5,
}

/**
 * Roster ceiling. Eight tanks is also the snapshot budget's limit.
 *
 * This is what the *wire* can carry, and it is not the number of people who
 * can play. Every versus map ships four spawn points -- Crossfire, Pillars and
 * The Moat, all four -- so a roster of eight seats twice as many players as
 * any map can place. Which of the two numbers is wrong is a design decision
 * that has not been made: cap the lobby at four, or give the maps four more
 * spawns each.
 *
 * Until it is, read this as an upper bound on the encoding rather than a
 * promise about seats, and take the real limit from the arena. The Bluetooth
 * seating path in packages/proto/game.js does exactly that and refuses the
 * fifth player.
 */
export const MAX_LOBBY_SLOTS = 8;

/**
 * Name length in *bytes*, not characters.
 *
 * Phone names are full of emoji, and one emoji is four bytes. Truncating on a
 * byte count without respecting codepoint boundaries produces a partial
 * sequence that TextDecoder renders as a replacement character, so a player
 * named with an emoji would see their name mangled on every other phone.
 */
export const MAX_NAME_BYTES = 16;

/**
 * Truncate to `MAX_NAME_BYTES` without splitting a UTF-8 codepoint.
 *
 * Continuation bytes are 10xxxxxx, so walking back off them lands on the start
 * of the character that would have been cut in half.
 */
export function clampName(name: string): string {
  const enc = new TextEncoder().encode(name);
  if (enc.length <= MAX_NAME_BYTES) return name;
  let end = MAX_NAME_BYTES;
  while (end > 0 && (enc[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(enc.subarray(0, end));
}

export interface WireLobbySlot {
  /** Stable id assigned by the host. Survives other players leaving. */
  slotId: number;
  name: string;
  team: number;
  ready: boolean;
  isHost: boolean;
}

export interface WireRoster {
  mapId: number;
  /** 0 = free-for-all, 1 = teams. Labelling only; the sim does not branch. */
  mode: number;
  roundsToWin: number;
  slots: WireLobbySlot[];
}

export function writeRoster(w: Writer, r: WireRoster): void {
  w.u8(MsgType.Lobby).u8(LobbyOp.Roster);
  w.u8(r.mapId).u8(r.mode).u8(r.roundsToWin);
  w.u8(r.slots.length);
  for (const s of r.slots) {
    w.u8(s.slotId).u8(s.team);
    w.u8((s.ready ? 1 : 0) | (s.isHost ? 2 : 0));
    w.str(clampName(s.name));
  }
}

export function readRoster(r: Reader): WireRoster {
  const mapId = r.u8();
  const mode = r.u8();
  const roundsToWin = r.u8();
  const count = r.u8();
  if (count > MAX_LOBBY_SLOTS) {
    // A corrupt count would otherwise drive a loop that reads garbage until it
    // runs off the end. Refusing early names the real problem.
    throw new Error(`roster claims ${count} slots, over the ${MAX_LOBBY_SLOTS} limit`);
  }
  const slots: WireLobbySlot[] = [];
  for (let i = 0; i < count; i++) {
    const slotId = r.u8();
    const team = r.u8();
    const flags = r.u8();
    slots.push({
      slotId,
      team,
      ready: (flags & 1) !== 0,
      isHost: (flags & 2) !== 0,
      name: r.str(),
    });
  }
  return { mapId, mode, roundsToWin, slots };
}

/** Client -> host requests, and the host's welcome. All tiny. */
export function writeLobbyJoin(w: Writer, name: string): void {
  w.u8(MsgType.Lobby).u8(LobbyOp.Join).str(clampName(name));
}

export function writeLobbySetTeam(w: Writer, team: number): void {
  w.u8(MsgType.Lobby).u8(LobbyOp.SetTeam).u8(team);
}

export function writeLobbySetReady(w: Writer, ready: boolean): void {
  w.u8(MsgType.Lobby).u8(LobbyOp.SetReady).u8(ready ? 1 : 0);
}

export function writeLobbyWelcome(w: Writer, slotId: number): void {
  w.u8(MsgType.Lobby).u8(LobbyOp.Welcome).u8(slotId);
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
