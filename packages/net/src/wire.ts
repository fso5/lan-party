/**
 * The byte codec every wire format on the platform is written with.
 *
 * Moved here from the tanks protocol, because it knows nothing about tanks: the
 * lobby's messages and each game's messages are all built from these. What a
 * byte *means* stays with whoever defines the message.
 */

/**
 * Longest string the length prefix can describe.
 *
 * `str` writes one byte of length and then the bytes. Over 255 that byte wraps,
 * and the result is the worst kind of wrong: nothing throws anywhere. Measured
 * with a 300-byte string followed by two more fields --
 *
 *     length byte on the wire = 44          (300 & 0xff)
 *     read back a string of length 44
 *     next two fields read as 0x78, 0x78    (sent 0xab, 0xcd -- 0x78 is 'x')
 *
 * -- so the reader hands back a plausible short string and then reads the rest
 * of the *payload* as though it were the fields that followed it. Every value
 * after a long string is silently a different value, and the frame still parses.
 *
 * Both callers today pass `clampName`, which caps at MAX_NAME_BYTES. That is a
 * product limit on a player's name and not a wire limit, and it does not
 * protect the next field somebody adds -- a map name, a hotspot SSID, a chat
 * line. This is the wire limit, so `str` is safe to reuse without every caller
 * having to remember.
 */
export const MAX_STR_BYTES = 0xff;

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
    if (enc.length > MAX_STR_BYTES) {
      throw new Error(
        `string is ${enc.length} bytes, over the ${MAX_STR_BYTES} the length prefix can describe -- ` +
          `it would wrap and every field after it would read from the wrong offset, without throwing`,
      );
    }
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
