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
  w.u8((input.fire ? 1 : 0) | (input.layMine ? 2 : 0));
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

/** Estimated bytes/sec downstream to one client, for budget checks in tests. */
export function estimateDownstreamBps(tankCount: number, snapshotHz: number): number {
  const snapshotBytes = 4 + tankCount * 6;
  return snapshotBytes * snapshotHz;
}
