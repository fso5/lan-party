import { describe, expect, test } from 'vitest';

import { base64ToBytes, bytesToBase64 } from '../src/net/base64';

/**
 * Base64 round-trip.
 *
 * Every BLE frame crosses this on the way to the radio and back. It is
 * hand-rolled because React Native has no dependable global btoa/atob, which
 * means the padding boundaries are ours to get wrong: lengths that are 1 or 2
 * modulo 3 take different branches, and a bug there corrupts the tail of a
 * packet rather than failing outright. A snapshot with a mangled last tank is
 * far worse than one that never arrived.
 */
describe('base64', () => {
  test('round-trips every length through the padding branches', () => {
    for (let len = 0; len <= 200; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff);
      const decoded = base64ToBytes(bytesToBase64(bytes));
      expect(Array.from(decoded), `length ${len}`).toEqual(Array.from(bytes));
    }
  });

  test('round-trips every possible byte value', () => {
    // Catches sign errors and any byte accidentally treated as a delimiter.
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(base64ToBytes(bytesToBase64(all)))).toEqual(Array.from(all));
  });

  test('matches the standard alphabet and padding', () => {
    // Pinned against known-correct vectors, so a self-consistent but wrong
    // implementation -- which a round-trip test alone would happily accept --
    // cannot pass. The native side decodes with the platform decoder, so
    // agreeing with ourselves is not enough.
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
    expect(bytesToBase64(new Uint8Array([0x66]))).toBe('Zg==');
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f]))).toBe('Zm8=');
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
    expect(bytesToBase64(new Uint8Array([0xff, 0xff, 0xff]))).toBe('////');
    expect(bytesToBase64(new Uint8Array([0x00, 0x00, 0x00]))).toBe('AAAA');
  });

  test('decodes the standard vectors', () => {
    expect(Array.from(base64ToBytes('Zg=='))).toEqual([0x66]);
    expect(Array.from(base64ToBytes('Zm8='))).toEqual([0x66, 0x6f]);
    expect(Array.from(base64ToBytes('Zm9v'))).toEqual([0x66, 0x6f, 0x6f]);
    expect(Array.from(base64ToBytes('////'))).toEqual([0xff, 0xff, 0xff]);
  });

  test('a realistic snapshot survives the trip intact', () => {
    // 4 header bytes + 6 per tank for 8 tanks, plus core's 2-byte fragment
    // header: the largest thing that routinely crosses this path.
    const frame = Uint8Array.from({ length: 54 }, (_, i) => (i * 91) & 0xff);
    expect(Array.from(base64ToBytes(bytesToBase64(frame)))).toEqual(Array.from(frame));
  });
});
