import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_STR_BYTES, Reader, TruncatedPacketError, Writer } from '@lan-party/net';

/**
 * Bounds checking.
 *
 * Reported by the other session while reviewing the transport work, and correct:
 * over BLE a truncated packet is a routine input, not an exotic one. A fragment
 * can be dropped, or a write cut short at a renegotiated MTU.
 */
test('every read refuses to run past the end of a packet', () => {
  const empty = new Reader(new Uint8Array(0));
  assert.throws(() => empty.u8(), TruncatedPacketError);
  assert.throws(() => empty.i8(), TruncatedPacketError);
  assert.throws(() => empty.u16(), TruncatedPacketError);
  assert.throws(() => empty.u32(), TruncatedPacketError);

  // One byte short of each width, which is where an off-by-one would hide.
  assert.throws(() => new Reader(new Uint8Array(1)).u16(), TruncatedPacketError);
  assert.throws(() => new Reader(new Uint8Array(3)).u32(), TruncatedPacketError);
  assert.throws(() => new Reader(new Uint8Array(2)).bytes(3), TruncatedPacketError);
});

test('a short read reports where it ran out, not just that it did', () => {
  const r = new Reader(new Uint8Array(3));
  r.u8();
  try {
    r.u32();
    assert.fail('expected a truncation error');
  } catch (err) {
    assert.ok(err instanceof TruncatedPacketError);
    // The offset is what makes a malformed-packet report actionable.
    assert.match(err.message, /offset 1/);
    assert.match(err.message, /2 remain/);
  }
});

test('u8 past the end throws rather than returning undefined', () => {
  // This is the failure mode that mattered. getUint16 past the end at least
  // throws a RangeError; u8 returned undefined, which flows into the arithmetic
  // that unpacks positions and produces NaN tank coordinates with no error
  // anywhere. A packet that ends early must be dropped, never half-applied.
  const r = new Reader(new Uint8Array([1]));
  assert.equal(r.u8(), 1);
  assert.throws(() => r.u8(), TruncatedPacketError);
});

test('a length prefix off the wire cannot make str over-read', () => {
  // The length byte is corruption-controlled: a flipped bit says "read 200
  // bytes" from a 4-byte packet.
  const r = new Reader(Uint8Array.from([200, 0x61, 0x62, 0x63]));
  assert.throws(() => r.str(), TruncatedPacketError);
});

/**
 * And the writer cannot create one either.
 *
 * The test above covers a length prefix arriving corrupt. This is the same
 * field going wrong at the other end, and it is the worse of the two because
 * nothing throws. Over 255 bytes the prefix wraps, so the reader is handed a
 * plausible short string and then reads the remaining payload as though it were
 * the fields that came after it. Measured before the guard existed, with a
 * 300-byte string followed by two bytes:
 *
 *     length byte on the wire = 44          (300 & 0xff)
 *     read back a string of length 44
 *     next two fields read as 0x78, 0x78    (sent 0xab, 0xcd -- 0x78 is 'x')
 *
 * Not reachable through either caller today: both pass `clampName`, which caps
 * at MAX_NAME_BYTES. But that is a limit on how long a player's name may be,
 * chosen for the roster, and it protects nothing about the next string field
 * somebody adds. The lobby is where those get added -- a map name, an SSID, a
 * chat line -- so the primitive holds the wire limit itself.
 */
test('a string the length prefix cannot describe is refused, not wrapped', () => {
  assert.throws(
    () => new Writer(512).str('x'.repeat(MAX_STR_BYTES + 1)),
    /over the 255 the length prefix can describe/,
  );

  // Exactly full still travels, so the guard is the wire limit and not one
  // short of it.
  const w = new Writer(512);
  w.str('x'.repeat(MAX_STR_BYTES));
  const r = new Reader(w.finish());
  assert.equal(r.str().length, MAX_STR_BYTES);

  // Bytes, not characters -- an emoji is four of them, so 64 of these are at
  // the limit and 65 are over it however short the string looks.
  assert.doesNotThrow(() => new Writer(512).str('🚀'.repeat(63)));
  assert.throws(() => new Writer(512).str('🚀'.repeat(64)), /over the 255/);
});
