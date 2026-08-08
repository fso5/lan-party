/**
 * What every reader does with bytes it did not expect.
 *
 * The threat model is not exotic. Everyone on the hotspot can reach the host's
 * socket, and over Bluetooth a mangled frame is a routine event rather than an
 * attack -- protocol.test.ts already says as much about truncation. What it
 * covers is a list of hand-written cases: this packet cut short here, that
 * length byte flipped there. Each one is a case somebody thought of.
 *
 * This is the other half: take a valid message, corrupt it at random, and
 * assert the properties that must hold whatever comes back. Not "does it
 * reject" -- rejecting is easy and mostly what happens. The dangerous outcome
 * is the packet that is ACCEPTED and wrong, because a NaN coordinate does not
 * stop at the reader. It reaches the world, spreads through the physics, and
 * surfaces as every phone disagreeing about where a tank is, with nothing left
 * pointing back at the byte that caused it.
 *
 * Three properties, in the order they matter:
 *
 *   1. Anything accepted is finite. No NaN, no Infinity, in any field.
 *   2. Nothing amplifies. An array or string decoded from N bytes may not have
 *      more than N entries -- a count byte says 200 but the buffer holds 12, so
 *      the reader must run out and refuse, not allocate on the packet's say-so.
 *   3. Anything rejected throws an Error, so the caller can catch and drop the
 *      peer. A thrown string or an undefined deref crosses a catch differently.
 *
 * And a fourth, about this file rather than the code: a corruption fuzzer whose
 * inputs all bounce off the first byte tests nothing. So the accepted fraction
 * is asserted too. Measured at 55-66% across the seven readers -- most
 * corruptions land in a payload byte and parse perfectly well into a different
 * value, which is exactly the region worth searching.
 *
 * Deterministic: one seeded PRNG, so a failure reproduces rather than
 * evaporating on the next run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Reader,
  Writer,
  readInput,
  readMatchStart,
  readMineSpawn,
  readRoster,
  readRoundOver,
  readShellSpawn,
  readSnapshot,
  writeInput,
  writeMatchStart,
  writeMineSpawn,
  writeRoster,
  writeRoundOver,
  writeShellSpawn,
  writeSnapshot,
} from '../src/net/protocol.js';

/** mulberry32, so the same seed walks the same corruptions on every machine. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Each case writes one valid message and reads its payload back.
 *
 * `header` is how many bytes the dispatcher consumes before choosing a reader:
 * one for a plain `MsgType`, two where an op follows it (`Event`, `Lobby`).
 * The readers start after that, exactly as the real receive path calls them.
 */
const CASES: { name: string; header: number; write: (w: Writer) => void; read: (r: Reader) => unknown }[] = [
  {
    name: 'input',
    header: 1,
    write: (w) =>
      writeInput(w, {
        tick: 1234,
        moveX: 0.5,
        moveY: -0.5,
        aimX: -0.25,
        aimY: 0.75,
        fire: true,
        layMine: false,
        fireSeq: 3,
        mineSeq: 1,
      }),
    read: (r) => readInput(r),
  },
  {
    name: 'snapshot',
    header: 1,
    write: (w) =>
      writeSnapshot(w, 4321, [
        { id: 0, x: 3.5, y: 4.25, bodyAngle: 1, turretAngle: 2, alive: true },
        { id: 1, x: 9.5, y: 1.25, bodyAngle: 3, turretAngle: 0, alive: false },
      ]),
    read: (r) => readSnapshot(r),
  },
  {
    name: 'shellSpawn',
    header: 2,
    write: (w) =>
      writeShellSpawn(w, { shellId: 7, ownerId: 2, x: 5, y: 6, angle: 1.5, bounces: 2, tick: 900 }),
    read: (r) => readShellSpawn(r),
  },
  {
    name: 'mineSpawn',
    header: 2,
    write: (w) => writeMineSpawn(w, { mineId: 3, ownerId: 1, x: 2, y: 2, tick: 900 }),
    read: (r) => readMineSpawn(r),
  },
  {
    name: 'matchStart',
    header: 1,
    write: (w) =>
      writeMatchStart(w, {
        mapId: 2,
        seed: 1007,
        hostTick: 900,
        yourTankId: 1,
        players: [
          { team: 0, spawnIndex: 0 },
          { team: 1, spawnIndex: 1 },
        ],
        bots: [{ kind: 2, team: 2, spawnIndex: 2 }],
      }),
    read: (r) => readMatchStart(r),
  },
  {
    name: 'roster',
    header: 2,
    write: (w) =>
      writeRoster(w, {
        mapId: 1,
        mode: 0,
        roundsToWin: 3,
        slots: [
          { slotId: 0, team: 0, ready: true, isHost: true, name: 'Ana' },
          { slotId: 1, team: 1, ready: false, isHost: false, name: 'Bo' },
        ],
      }),
    read: (r) => readRoster(r),
  },
  {
    name: 'roundOver',
    header: 2,
    write: (w) =>
      writeRoundOver(w, {
        winner: 1,
        resumeAtTick: 1080,
        scores: [
          { team: 0, score: 1 },
          { team: 1, score: 2 },
        ],
        matchOver: false,
      }),
    read: (r) => readRoundOver(r),
  },
];

/**
 * Walk a decoded message and report anything that should not be there.
 *
 * `limit` is the length of the buffer it came from: property 2 above. A reader
 * handed twelve bytes has no honest way to produce a two-hundred-element array,
 * whatever the count byte claims.
 */
function faults(value: unknown, path: string, limit: number, out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}`);
  } else if (typeof value === 'string') {
    if (value.length > limit) out.push(`${path} is ${value.length} chars from a ${limit}-byte packet`);
  } else if (Array.isArray(value)) {
    if (value.length > limit) out.push(`${path} has ${value.length} entries from a ${limit}-byte packet`);
    value.forEach((entry, i) => faults(entry, `${path}[${i}]`, limit, out));
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      faults((value as Record<string, unknown>)[key], `${path}.${key}`, limit, out);
    }
  }
  return out;
}

const CORRUPTIONS = 4000;

for (const { name, header, write, read } of CASES) {
  test(`${name} survives a corrupted wire without producing nonsense`, () => {
    const w = new Writer();
    write(w);
    /*
     * Drop the dispatch bytes the receive path has already eaten.
     *
     * One for a plain message type, two for anything under Event or Lobby,
     * which name an op as well. Getting this wrong is not a loud failure --
     * the reader parses the shifted bytes quite happily and every number that
     * comes out is wrong -- so the fixture is checked below rather than
     * assumed.
     */
    const pristine = w.finish().slice(header);

    /*
     * The fixture has to be valid before it is worth corrupting.
     *
     * Written after doing exactly this wrong: the first draft skipped one byte
     * for all seven, so the three Event messages were parsed one byte out of
     * alignment. It still produced a confident table of results -- every one
     * of them about a message that was already malformed.
     */
    assert.doesNotThrow(
      () => read(new Reader(pristine)),
      `the uncorrupted ${name} fixture does not parse, so nothing below is about ${name}`,
    );

    const rand = rng(0xc0ffee);
    let accepted = 0;
    const problems: string[] = [];

    for (let i = 0; i < CORRUPTIONS; i++) {
      const buf = Uint8Array.from(pristine);
      // Three ways a packet goes wrong on a real link: a flipped bit from
      // radio noise, a wholly wrong byte, and a frame that stops early.
      const kind = Math.floor(rand() * 3);
      let bytes = buf;
      if (kind === 0) buf[Math.floor(rand() * buf.length)] ^= 1 << Math.floor(rand() * 8);
      else if (kind === 1) buf[Math.floor(rand() * buf.length)] = Math.floor(rand() * 256);
      else bytes = buf.slice(0, Math.max(1, Math.floor(rand() * buf.length)));

      let value: unknown;
      try {
        value = read(new Reader(bytes));
      } catch (err) {
        if (!(err instanceof Error)) {
          problems.push(`corruption ${i} threw a non-Error: ${String(err)}`);
        }
        continue;
      }
      accepted++;
      for (const fault of faults(value, name, bytes.length)) {
        problems.push(`corruption ${i} (${bytes.length} bytes) accepted with ${fault}`);
      }
    }

    assert.deepEqual(problems.slice(0, 5), [], `${problems.length} bad outcome(s) over ${CORRUPTIONS} corruptions`);

    /*
     * The test's own vacuity check.
     *
     * If nearly everything were rejected this would be measuring the first
     * bounds check and nothing past it. A quarter is well under the 55-66%
     * measured across these seven readers, so it fails on a real collapse in
     * coverage rather than on noise.
     *
     * Not demonstrated by mutation, and worth saying so: every mutation that
     * drives acceptance to zero also stops the pristine fixture parsing, so
     * the check above fires first and this one is never reached. What it is
     * really for is a future change that keeps valid messages valid while
     * making corrupt ones trivially rejectable -- a checksum or a magic prefix
     * on every packet would do it -- after which these seven tests would still
     * pass while testing almost nothing. The fixture check cannot see that.
     */
    assert.ok(
      accepted > CORRUPTIONS / 4,
      `only ${accepted} of ${CORRUPTIONS} corruptions were accepted, so this is testing the reject path and little else`,
    );
  });
}
