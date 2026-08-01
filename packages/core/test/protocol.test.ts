import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAX_QUANT_POS,
  Reader,
  TruncatedPacketError,
  Writer,
  dequantPos,
  quantPos,
  readSnapshot,
  writeInput,
  writeSnapshot,
} from '../src/net/protocol.js';

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

test('a truncated snapshot is rejected instead of yielding NaN tanks', () => {
  const w = new Writer(64);
  writeSnapshot(w, 1234, [
    { id: 0, x: 3.5, y: 4.5, bodyAngle: 0.5, turretAngle: 1, alive: true },
    { id: 1, x: 9.5, y: 2.5, bodyAngle: -1, turretAngle: 2, alive: true },
  ]);
  const full = w.finish();

  // Whole packet parses.
  const ok = new Reader(full);
  ok.u8();
  assert.equal(readSnapshot(ok).tanks.length, 2);

  // Cut anywhere inside the second tank's record and it must throw, not
  // silently return one and a half tanks.
  for (let cut = full.length - 1; cut > 4; cut--) {
    const r = new Reader(full.subarray(0, cut));
    r.u8();
    assert.throws(() => readSnapshot(r), TruncatedPacketError, `cut at ${cut}`);
  }
});

test('a truncated input frame is rejected', () => {
  const w = new Writer(16);
  writeInput(w, { tick: 7, moveX: 1, moveY: 0, aimX: 0, aimY: 1, fire: true, layMine: false });
  const full = w.finish();
  for (let cut = 1; cut < full.length; cut++) {
    const r = new Reader(full.subarray(0, cut));
    r.u8();
    assert.throws(
      () => {
        r.u16();
        r.i8();
        r.i8();
        r.i8();
        r.i8();
        r.u8();
      },
      TruncatedPacketError,
      `cut at ${cut}`,
    );
  }
});

/**
 * Quantisation.
 *
 * Also reported by the other session: `& 0xfff` wrapped, so a tank at the very
 * edge of an oversized arena would be sent as x=0 -- a teleport across the map
 * rather than a small error, and one that would first show up the day someone
 * authors a wider map.
 */
test('positions clamp at the field limit instead of wrapping', () => {
  assert.equal(quantPos(0), 0);
  assert.equal(quantPos(31.9921875), MAX_QUANT_POS); // 4095/128
  assert.equal(quantPos(32), MAX_QUANT_POS, 'must clamp, not wrap to 0');
  assert.equal(quantPos(100), MAX_QUANT_POS);
  assert.equal(quantPos(-5), 0, 'negative must clamp to 0, not wrap high');

  // The failure the old code produced: an edge tank arriving at the origin.
  assert.notEqual(dequantPos(quantPos(32)), 0);
  assert.ok(dequantPos(quantPos(32)) > 31.9);
});

test('positions inside the arena still round-trip within a visual tolerance', () => {
  for (let v = 0; v <= 31.9; v += 0.013) {
    assert.ok(Math.abs(dequantPos(quantPos(v)) - v) < 1 / 128, `at ${v}`);
  }
});

/**
 * Packaging.
 *
 * This exists because of a bug the other session hit and reported: core
 * declared an entry point that tsc never emitted, and separately used
 * `export const enum`, which tsc erases entirely -- so `import { TankKind }`
 * threw at runtime for any real consumer. Their build aliased the package to
 * its TypeScript source, which hid both completely.
 *
 * Testing the source cannot catch either. This loads the built artifact through
 * the entry point package.json advertises, exactly as a consumer would.
 */
test('the published entry point exists and exports runtime values', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, '..', '..');
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

  const entry = resolve(pkgRoot, pkg.main);
  const mod = await import(pathToFileURL(entry).href);

  // Enums must survive compilation as real objects. `const enum` compiles away
  // and these lookups would be undefined.
  for (const name of ['TankKind', 'Tile', 'EventKind', 'MsgType', 'NetEvent', 'TransportKind']) {
    assert.equal(typeof mod[name], 'object', `${name} must be a runtime value`);
  }
  assert.equal(mod.TankKind.Player, 0);
  assert.equal(mod.Tile.Wall, 1);

  // A representative slice of the API a consumer actually calls.
  for (const name of [
    'createWorld',
    'step',
    'loadArena',
    'MatchHost',
    'MatchClient',
    'BleTransport',
    'Reader',
    'Writer',
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} must be exported`);
  }
});
