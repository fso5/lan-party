/**
 * Lobby protocol and live round scoring.
 *
 * This is the layer where the product goal is actually expressed: "teams, one
 * or many". `rules.ts` proved the scoring logic in isolation, but until the
 * host called it and the wire carried it, teams were a library nobody used.
 * These tests pin the path from a lobby choosing sides to a scoreboard both
 * phones agree on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, cloneWorld } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import {
  LobbyOp,
  MAX_LOBBY_SLOTS,
  MAX_NAME_BYTES,
  MsgType,
  NetEvent,
  Reader,
  TruncatedPacketError,
  Writer,
  clampName,
  readRoster,
  readRoundOver,
  writeLobbyJoin,
  writeLobbySetTeam,
  writeRoster,
  writeRoundOver,
  type WireRoster,
} from '../src/net/protocol.js';
import { LoopbackNetwork, LoopbackTransport, PERFECT_PROFILE } from '../src/net/loopback.js';
import { MatchHost } from '../src/net/host.js';
import { MatchClient } from '../src/net/client.js';
import { DRAW } from '../src/rules.js';

const ROSTER: WireRoster = {
  mapId: 2,
  mode: 1,
  roundsToWin: 3,
  slots: [
    { slotId: 0, name: 'Forrest', team: 0, ready: true, isHost: true },
    { slotId: 1, name: 'Sam', team: 1, ready: false, isHost: false },
    { slotId: 2, name: 'Alex', team: 2, ready: true, isHost: false },
  ],
};

test('a roster round-trips every field', () => {
  const w = new Writer(128);
  writeRoster(w, ROSTER);
  const r = new Reader(w.finish());
  assert.equal(r.u8(), MsgType.Lobby);
  assert.equal(r.u8(), LobbyOp.Roster);
  assert.deepEqual(readRoster(r), ROSTER);
});

test('a roster carries more than two teams', () => {
  // The whole point of the feature. Eight players on eight teams is
  // free-for-all; nothing in the protocol may cap teams below the roster size.
  const slots = Array.from({ length: MAX_LOBBY_SLOTS }, (_, i) => ({
    slotId: i,
    name: `P${i}`,
    team: i,
    ready: true,
    isHost: i === 0,
  }));
  const w = new Writer(256);
  writeRoster(w, { mapId: 0, mode: 0, roundsToWin: 3, slots });
  const r = new Reader(w.finish());
  r.u8();
  r.u8();
  const back = readRoster(r);
  assert.equal(new Set(back.slots.map((s) => s.team)).size, MAX_LOBBY_SLOTS);
});

test('a full roster fits one BLE write', () => {
  // Lobby traffic is reliable and fragmentable, so this is not fatal -- but a
  // roster that needs fragmenting turns every team tap into a multi-packet
  // exchange on a link where that is the expensive thing.
  const slots = Array.from({ length: MAX_LOBBY_SLOTS }, (_, i) => ({
    slotId: i,
    name: 'A'.repeat(MAX_NAME_BYTES),
    team: i,
    ready: true,
    isHost: i === 0,
  }));
  const w = new Writer(256);
  writeRoster(w, { mapId: 0, mode: 0, roundsToWin: 5, slots });
  assert.ok(w.length <= 180, `worst-case roster is ${w.length}B, over the 180B BLE payload`);
});

test('a name is truncated on a character boundary, not a byte count', () => {
  // Phone names are full of emoji and CJK, and those are 4 and 3 bytes. Cutting
  // at a byte count mid-sequence yields a replacement character, so a player
  // would watch their own name get mangled on every other phone.
  //
  // The cases that matter are the ones where the limit lands *inside* a
  // character. 4-byte emoji divide into 16 exactly, so they never exercise the
  // walk-back -- an earlier version of this test used only emoji and passed
  // against a truncator that ignored boundaries entirely.
  const cjk = '日'.repeat(8); // 24 bytes; the 16-byte limit falls mid-character
  const clampedCjk = clampName(cjk);
  assert.equal(clampedCjk, '日'.repeat(5), 'must drop the character the limit bisects');
  assert.ok(!clampedCjk.includes('�'), 'no replacement characters');
  assert.ok(new TextEncoder().encode(clampedCjk).length <= MAX_NAME_BYTES);

  // Two-byte characters land the limit mid-character at a different offset.
  const accented = 'é'.repeat(9); // 18 bytes
  assert.equal(clampName(accented), 'é'.repeat(8));

  // And the aligned case must still be exact rather than over-trimmed.
  assert.equal(clampName('🚀'.repeat(8)), '🚀'.repeat(4));

  // Through the wire, which is where a mangled name would actually be seen.
  const w = new Writer(64);
  writeRoster(w, { ...ROSTER, slots: [{ slotId: 0, name: cjk, team: 0, ready: false, isHost: true }] });
  const r = new Reader(w.finish());
  r.u8();
  r.u8();
  const back = readRoster(r).slots[0].name;
  assert.equal(back, '日'.repeat(5));
  assert.ok(!back.includes('�'));
});

test('short names are left exactly alone', () => {
  assert.equal(clampName('Sam'), 'Sam');
  assert.equal(clampName(''), '');
});

test('a corrupt slot count is refused rather than read as garbage', () => {
  // The count comes off the wire, so a flipped bit asks for 200 slots.
  const bad = Uint8Array.from([0, 0, 3, 200]);
  assert.throws(() => readRoster(new Reader(bad)), /over the 8 limit/);
});

test('a truncated roster throws instead of yielding half a player list', () => {
  const w = new Writer(128);
  writeRoster(w, ROSTER);
  const full = w.finish();
  for (let cut = full.length - 1; cut > 2; cut--) {
    const r = new Reader(full.subarray(0, cut));
    r.u8();
    r.u8();
    assert.throws(() => readRoster(r), TruncatedPacketError, `cut at ${cut}`);
  }
});

test('client requests are small enough to be free', () => {
  const join = new Writer(32);
  writeLobbyJoin(join, 'Forrest');
  const team = new Writer(8);
  writeLobbySetTeam(team, 3);
  assert.ok(join.length < 32);
  assert.equal(team.length, 3, 'a team change is three bytes');
});

test('a round result round-trips, including a draw', () => {
  const w = new Writer(32);
  writeRoundOver(w, { winner: DRAW, resumeAtTick: 500, scores: [{ team: 0, score: 1 }] });
  const r = new Reader(w.finish());
  assert.equal(r.u8(), MsgType.Event);
  assert.equal(r.u8(), NetEvent.RoundOver);
  const back = readRoundOver(r);
  // DRAW is -1 in memory and 0xff on the wire; a byte cannot hold -1, and
  // reading it back as 255 would create a phantom team 255 on the scoreboard.
  assert.equal(back.winner, DRAW);
  assert.equal(back.resumeAtTick, 500);
  assert.deepEqual(back.scores, [{ team: 0, score: 1 }]);
});

/** Four players, each on their own team -- free-for-all. */
function ffaWorld() {
  return createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 42,
    players: Array.from({ length: 4 }, (_, i) => ({ team: i, spawnIndex: i })),
  });
}

test('the host seeds its scoreboard from whoever is in the arena', () => {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 5);
  const host = new MatchHost(ffaWorld(), new LoopbackTransport('host', 'Host', net));

  // Four players on four teams is free-for-all, and the host must discover
  // that from the roster rather than being told which mode it is in.
  assert.deepEqual([...host.match.score.keys()].sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.equal(host.match.phase, 'playing');
});

test('a host with two teams scores 2v2 the same way', () => {
  const world = createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 42,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
      { team: 0, spawnIndex: 2 },
      { team: 1, spawnIndex: 3 },
    ],
  });
  const net = new LoopbackNetwork(PERFECT_PROFILE, 5);
  const host = new MatchHost(world, new LoopbackTransport('host', 'Host', net));
  assert.deepEqual([...host.match.score.keys()].sort((a, b) => a - b), [0, 1]);
});

test('a decided round scores on the host and reaches the client', () => {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 5);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);

  const world = ffaWorld();
  const host = new MatchHost(world, hostT);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 1);
  net.connect('host', 'client');
  host.addClient('client', 1);

  // Asserted through a local: under @types/node these are assertion
  // signatures, so asserting on the property itself narrows it to null for the
  // rest of the test and every later access becomes a type error.
  const before = client.lastRound;
  assert.equal(before, null, 'no round result before one is decided');

  // Leave one team standing, then let the host step over it.
  for (const t of host.world.tanks) if (t.team !== 2) t.alive = false;
  host.update(1000 / 60);
  net.advance(50);

  assert.equal(host.match.score.get(2), 1, 'the surviving team takes the round');
  assert.equal(host.match.phase, 'intermission');

  assert.ok(client.lastRound, 'the client must be told the round ended');
  assert.equal(client.lastRound.winner, 2);
  assert.deepEqual(
    client.lastRound.scores.find((s) => s.team === 2),
    { team: 2, score: 1 },
    'the scoreboard rides the wire rather than being recomputed',
  );
});

test('mutual destruction reaches the client as a draw, not as team 255', () => {
  const net = new LoopbackNetwork(PERFECT_PROFILE, 5);
  const hostT = new LoopbackTransport('host', 'Host', net);
  const clientT = new LoopbackTransport('client', 'Client', net);

  const world = ffaWorld();
  const host = new MatchHost(world, hostT);
  const client = new MatchClient(cloneWorld(world), clientT, 'host', 1);
  net.connect('host', 'client');
  host.addClient('client', 1);

  for (const t of host.world.tanks) t.alive = false;
  host.update(1000 / 60);
  net.advance(50);

  const result = client.lastRound;
  assert.ok(result, 'the client must be told the round ended');
  assert.equal(result.winner, DRAW);
  for (const s of result.scores) {
    assert.equal(s.score, 0, 'a draw scores nothing for anyone');
  }
});

test('the host does not re-score the same round every tick', () => {
  // updateMatch runs 60 times a second. A missing phase guard would hand the
  // winner a point on each of them, and the match would end instantly.
  const net = new LoopbackNetwork(PERFECT_PROFILE, 5);
  const host = new MatchHost(ffaWorld(), new LoopbackTransport('host', 'Host', net));

  for (const t of host.world.tanks) if (t.team !== 0) t.alive = false;
  for (let i = 0; i < 30; i++) host.update(1000 / 60);

  assert.equal(host.match.score.get(0), 1, 'exactly one point for one round');
});
