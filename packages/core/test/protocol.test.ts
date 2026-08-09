import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAX_QUANT_POS,
  MAX_WIRE_BOUNCES,
  PROTOCOL_VERSION,
  MsgType,
  NetEvent,
  Reader,
  TruncatedPacketError,
  Writer,
  dequantPos,
  quantPos,
  MAX_LOBBY_SLOTS,
  MAX_WIRE_TANKS,
  readMineSpawn,
  readMatchStart,
  readShellSpawn,
  readSnapshot,
  writeInput,
  writeMineSpawn,
  writeMatchStart,
  writeShellSpawn,
  writeSnapshot,
} from '../src/net/protocol.js';
import { TANK_SPECS } from '../src/tuning.js';
import { BLE_SAFE_MTU, FRAME_HEADER_BYTES } from '../src/net/ble.js';

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
  /*
   * Search upward for the package rather than counting directories.
   *
   * `resolve(here, '..', '..')` was right for exactly one layout. Compiled,
   * this file runs from dist-test/test/ and two levels up is packages/core;
   * from source it runs from test/ and two levels up is packages/, so
   * `npx tsx --test test/*.test.ts` failed on a missing packages/package.json.
   * A red suite for a reason that has nothing to do with the code is worse
   * than no check, because the obvious way to quiet it is to weaken the test.
   */
  let pkgRoot = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).name === '@tanks/core') {
        break;
      }
    } catch {
      // No package.json here, or not readable. Keep climbing.
    }
    const up = dirname(pkgRoot);
    assert.notEqual(up, pkgRoot, 'walked to the filesystem root without finding @tanks/core');
    pkgRoot = up;
  }
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

/**
 * The wire format's fixed-width fields against the game that has to fit in
 * them.
 *
 * `writeShellSpawn` packs the bounce count into two bits and the owner into
 * four, and both are written with a mask -- so a value that does not fit is
 * not rejected, it is silently truncated. The shell then arrives describing a
 * different trajectory from the one the host fired, and since clients simulate
 * shells locally rather than receiving their positions, the divergence is
 * visible in play: a shell that stops bouncing on one phone and carries on
 * upon another.
 *
 * Nothing in the game exceeds either field today. This exists so the day
 * someone adds a shell that ricochets four times, or seats a ninth player,
 * that shows up here rather than as an argument about whose phone is wrong.
 * Flagged by the other session reading protocol.ts (issue #2, finding 3).
 */
test('every shell profile and player slot fits the bits the wire gives it', () => {
  // Read from the source rather than restated here. When this test was written
  // it carried its own `BOUNCE_BITS = 2` beside the encoder's bare `0x03`, so
  // widening the field meant editing both -- and editing only the encoder would
  // have left this test failing a change that was correct, while editing only
  // the test would have let an over-wide count through to be masked in silence.
  const maxBounces = MAX_WIRE_BOUNCES;
  const OWNER_BITS = 4;
  const maxOwner = (1 << OWNER_BITS) - 1;

  for (const [kind, spec] of Object.entries(TANK_SPECS)) {
    assert.ok(
      spec.shell.maxBounces <= maxBounces,
      `tank kind ${kind} fires a shell with ${spec.shell.maxBounces} bounces; ` +
        `the wire field holds ${maxBounces}. Widen it -- the packed byte has spare bits.`,
    );
  }

  // Tank ids come from the roster order, so the last seat is the largest id.
  assert.ok(
    MAX_LOBBY_SLOTS - 1 <= maxOwner,
    `${MAX_LOBBY_SLOTS} lobby slots means an owner id up to ${MAX_LOBBY_SLOTS - 1}, ` +
      `and the wire field holds ${maxOwner}`,
  );

  // And the masking really is silent, which is why the check above exists.
  const w = new Writer();
  writeShellSpawn(w, { shellId: 1, ownerId: 0, x: 1, y: 1, angle: 0, bounces: maxBounces + 1, tick: 0 });
  const r = new Reader(w.finish());
  r.u8();
  r.u8();
  assert.equal(readShellSpawn(r).bounces, 0, 'an over-wide bounce count wraps rather than failing');
});

/**
 * MatchStart, which decides what world every client builds.
 *
 * It had no test naming it. Not uncovered -- the browser suites write it from
 * the host and read it on the page every run -- but covered only at the shape
 * those happen to use, which is a couple of players and a couple of bots. The
 * fields that grow are the ones a full lobby fills, and a roster that comes
 * back in the wrong order is not a visible failure: every client builds tanks
 * in creation order and takes its ids from position, so a swapped pair means
 * two people driving each other's tanks with nothing on screen to say so.
 */
test('a match start round-trips a full lobby, field for field', () => {
  const sent = {
    mapId: 103,
    // Distinct in every byte, so a mis-sized read shows up as a wrong value
    // rather than a plausible one.
    seed: 0xdeadbeef,
    hostTick: 0xfeed,
    yourTankId: 7,
    players: Array.from({ length: MAX_LOBBY_SLOTS }, (_, i) => ({
      team: MAX_LOBBY_SLOTS - 1 - i,
      spawnIndex: i,
    })),
    bots: [
      { kind: 2, team: 90, spawnIndex: 1 },
      { kind: 3, team: 91, spawnIndex: 2 },
      { kind: 5, team: 92, spawnIndex: 3 },
    ],
  };

  const w = new Writer();
  writeMatchStart(w, sent);
  const buf = w.finish();

  const r = new Reader(buf);
  assert.equal(r.u8(), MsgType.MatchStart, 'the type byte leads');
  const got = readMatchStart(r);

  assert.equal(got.mapId, sent.mapId);
  assert.equal(got.seed, sent.seed, 'a 32-bit seed must survive intact');
  assert.equal(got.hostTick, sent.hostTick);
  assert.equal(got.yourTankId, sent.yourTankId);
  // deepEqual on the arrays, because order is the load-bearing part.
  assert.deepEqual(got.players, sent.players);
  assert.deepEqual(got.bots, sent.bots);
  assert.equal(r.remaining, 0, 'the reader must consume exactly what was written');

  // Stated rather than asserted tightly: a full lobby is 41 bytes, so it fits
  // one BLE write at the negotiated MTU and fragments at the 18-byte floor,
  // which is the path BleFramer covers.
  assert.ok(buf.length < 180, `a full match start is ${buf.length}B`);
});

test('a match start from a different build is refused, not misread', () => {
  // The version byte exists because the roster layout has changed before and
  // will again. A phone running a cached older page reading a newer host's
  // roster would not fail -- it would build a plausible world with the fields
  // slid along by a byte.
  const w = new Writer();
  writeMatchStart(w, {
    mapId: 101, seed: 1, hostTick: 0, yourTankId: 0,
    players: [{ team: 0, spawnIndex: 0 }], bots: [],
  });
  const buf = w.finish();
  buf[1] = PROTOCOL_VERSION + 1;

  const r = new Reader(buf);
  r.u8();
  assert.throws(() => readMatchStart(r), /protocol version mismatch/);
});

test('a truncated match start is rejected rather than half-applied', () => {
  const w = new Writer();
  writeMatchStart(w, {
    mapId: 101, seed: 7, hostTick: 3, yourTankId: 1,
    players: [{ team: 0, spawnIndex: 0 }, { team: 1, spawnIndex: 1 }],
    bots: [{ kind: 2, team: 90, spawnIndex: 2 }],
  });
  const full = w.finish();

  for (let cut = 1; cut < full.length; cut++) {
    const r = new Reader(full.subarray(0, cut));
    r.u8();
    assert.throws(() => readMatchStart(r), TruncatedPacketError, `cut at ${cut}`);
  }
});

test('a mine spawn round-trips, including the two ends of the arena', () => {
  // x and y share a byte, four bits of each in opposite nibbles, which is the
  // easiest place in the whole format to transpose. A mine at (2.5, 1.5) and
  // one at (1.5, 2.5) pack to byte patterns that a swap maps onto each other,
  // so the corners are what actually catch it.
  for (const [x, y] of [
    [2.5, 1.5],
    [1.5, 2.5],
    [21.5, 1.5],
    [0.25, 13.75],
    [31.5, 31.5],
  ]) {
    const w = new Writer();
    writeMineSpawn(w, { mineId: 200, ownerId: 5, x, y, tick: 4321 });
    const r = new Reader(w.finish());
    assert.equal(r.u8(), MsgType.Event);
    assert.equal(r.u8(), NetEvent.MineSpawn);
    const back = readMineSpawn(r);
    assert.equal(back.mineId, 200);
    assert.equal(back.ownerId, 5);
    assert.equal(back.tick, 4321);
    assert.ok(Math.abs(back.x - x) < 1 / 128, `x ${x} came back as ${back.x}`);
    assert.ok(Math.abs(back.y - y) < 1 / 128, `y ${y} came back as ${back.y}`);
  }
});

/**
 * A snapshot's cost per tank, which is what decides the host's write rate.
 *
 * Snapshots are the only thing the host sends on a fixed clock -- everything
 * else (shell spawns, mines, kills) is an event, sent when it happens. So the
 * floor of the radio's load is `fragments(snapshot) * SNAPSHOT_HZ` writes per
 * second to *every* client, because BLE notifications are per-connection and
 * there is no broadcast on the radio.
 *
 * Measured on a full roster with everyone holding the trigger, the host makes
 * roughly 530 writes/s at the 20-byte BLE floor and 320 at a negotiated MTU.
 * That is comfortable. It stops being comfortable quietly: WireTank is six
 * bytes, and a full roster lands at 52 -- three fragments at the floor, with
 * two bytes to spare. One more byte per tank makes it 60, a fourth fragment,
 * and a third more radio traffic at the exact moment the arena is fullest.
 *
 * Nothing about that failure looks like a protocol change. It looks like BLE
 * being flaky with a lot of players, on the phones with the worst radios.
 */
test('a full-roster snapshot stays within its fragment budget on the worst link', () => {
  const snapshotBytes = (tanks: number) => {
    const w = new Writer(256);
    writeSnapshot(
      w,
      1234,
      Array.from({ length: tanks }, (_, i) => ({
        id: i,
        x: 5.5 + i,
        y: 4.5,
        bodyAngle: 1,
        turretAngle: 2,
        alive: true,
      })),
    );
    return w.finish().length;
  };

  // Stated as a difference rather than a total, so this pins the per-tank cost
  // itself and not the header alongside it.
  const perTank = snapshotBytes(MAX_LOBBY_SLOTS) - snapshotBytes(MAX_LOBBY_SLOTS - 1);
  assert.equal(perTank, 6, 'a tank on the wire is 6 bytes: id+alive, 12-bit x and y, two angles');

  const full = snapshotBytes(MAX_LOBBY_SLOTS);
  assert.equal(full, 4 + MAX_LOBBY_SLOTS * 6, 'header is type, 16-bit tick, count');

  // The floor every BLE stack must accept, minus the framer's own header.
  const floor = 20 - FRAME_HEADER_BYTES;
  assert.equal(
    Math.ceil(full / floor),
    3,
    `a full snapshot is ${full}B = ${Math.ceil(full / floor)} fragments at the ${floor}B floor; ` +
      'a fourth raises the host write rate by a third with the arena at its fullest',
  );

  // On a link that negotiated an MTU it must not fragment at all.
  assert.equal(Math.ceil(full / (BLE_SAFE_MTU - FRAME_HEADER_BYTES)), 1);
});

/**
 * The wire can only name sixteen tanks, and says so rather than masking.
 *
 * Four bits, used for a tank's id in every snapshot and for a shell's and a
 * mine's owner. Left to `& 0x0f`, tank 16 travels as tank 0: two tanks drawn on
 * each other, kills credited to the wrong player, and a shell arming against a
 * stranger while passing through its owner. The failure is silent and looks
 * nothing like a wire format out of bits.
 *
 * All three writers, deliberately. Only the snapshot was guarded for a while,
 * and that is the wrong one to pick if you are only picking one: a renumbered
 * tank in a snapshot is visible the moment anyone looks at the arena, whereas a
 * renumbered `ownerId` is a kill credited to a stranger and reads as a scoring
 * bug. A shell's and a mine's owner is a `tank.id` off the same roster, so the
 * three share an id space and now share the guard on it.
 *
 * Not reachable today -- measured across every shipped map, the worst assembles
 * eight tanks counting authored enemies, against sixteen available. That is the
 * reason to write it down rather than the reason to skip it: eight spare seats
 * is exactly the kind of margin someone spends without checking.
 */
test('a tank the wire cannot name is refused, not silently renumbered', () => {
  const tank = (id: number) => ({
    id,
    x: 5.5,
    y: 4.5,
    bodyAngle: 1,
    turretAngle: 2,
    alive: true,
  });

  // Each writer that packs a tank id into those four bits, keyed by the field
  // it names, so a new one added without a guard shows up as a missing row
  // rather than as nothing at all.
  const writers: { field: string; write: (id: number) => void }[] = [
    { field: 'tank id', write: (id) => writeSnapshot(new Writer(256), 1, [tank(id)]) },
    {
      field: 'shell owner id',
      write: (id) =>
        writeShellSpawn(new Writer(256), {
          shellId: 3,
          ownerId: id,
          x: 5.5,
          y: 4.5,
          angle: 1,
          bounces: 1,
          tick: 7,
        }),
    },
    {
      field: 'mine owner id',
      write: (id) =>
        writeMineSpawn(new Writer(256), { mineId: 3, ownerId: id, x: 5.5, y: 4.5, tick: 7 }),
    },
  ];

  for (const { field, write } of writers) {
    assert.throws(
      () => write(MAX_WIRE_TANKS),
      /cannot be sent/,
      `${field} ${MAX_WIRE_TANKS} would have gone out as 0`,
    );

    // Below the floor as well as above the ceiling. `-1 & 0x0f` is 15, so an
    // unset or sentinel owner does not arrive as an absent one -- it arrives as
    // the last seat in the lobby, which is a real player.
    assert.throws(() => write(-1), /cannot be sent/, `${field} -1 would have gone out as 15`);

    // The boundary in the other direction, so the guard cannot be tightened
    // into rejecting a legal tank without a test noticing.
    assert.doesNotThrow(() => write(MAX_WIRE_TANKS - 1), `${field} refuses a legal id`);
    assert.doesNotThrow(() => write(0), `${field} refuses id 0`);
  }
});

test('the id space is wider than the lobby can fill', () => {
  // If a seat-cap rise ever takes MAX_LOBBY_SLOTS past this, snapshots start
  // throwing mid-match rather than at the point the cap was changed. This is
  // the check that makes that a red build instead.
  assert.ok(
    MAX_LOBBY_SLOTS <= MAX_WIRE_TANKS,
    `${MAX_LOBBY_SLOTS} seats cannot fit an id space of ${MAX_WIRE_TANKS}`,
  );
});
