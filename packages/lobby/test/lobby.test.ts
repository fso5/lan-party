/**
 * The lobby's wire protocol.
 *
 * Moved from the tanks suite along with the protocol itself. The bytes did not
 * change, so neither did these tests beyond where they import from.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Reader, TruncatedPacketError, Writer } from '@lan-party/net';
import {
  LOBBY_MSG,
  LobbyOp,
  MAX_LOBBY_SLOTS,
  MAX_NAME_BYTES,
  clampName,
  readRoster,
  writeLobbyJoin,
  writeLobbySetReady,
  writeLobbySetTeam,
  writeLobbyWelcome,
  writeRoster,
  type WireRoster,
} from '../src/index.js';

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
  assert.equal(r.u8(), LOBBY_MSG);
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

/**
 * And the host cannot build one either.
 *
 * The reader has refused an over-long count since it was written, and for a
 * while the writer would still produce one -- so a host that seated a ninth
 * player sent a packet every client threw on. That is a much quieter failure
 * than it sounds. The roster is the only way a lobby screen learns who is in
 * it, so what the other phones show is a roster that stops updating: a lobby
 * that has apparently hung, with no error anywhere except on the host, which is
 * the one screen still displaying the right thing.
 *
 * The host is where the seating decision was made and the only place with
 * enough context to say so, which is why this is a writer guard and not a
 * larger limit.
 */
test('a host cannot send a roster its own reader would refuse', () => {
  const slot = (i: number) => ({
    slotId: i,
    name: `P${i}`,
    team: i,
    ready: false,
    isHost: i === 0,
  });
  const roster = (n: number): WireRoster => ({
    mapId: 0,
    mode: 0,
    roundsToWin: 3,
    slots: Array.from({ length: n }, (_, i) => slot(i)),
  });

  assert.throws(
    () => writeRoster(new Writer(256), roster(MAX_LOBBY_SLOTS + 1)),
    /over the 8 limit/,
    'a ninth seat produced a packet no client can parse',
  );

  // The boundary in the other direction, so a full lobby stays sendable.
  assert.doesNotThrow(() => writeRoster(new Writer(256), roster(MAX_LOBBY_SLOTS)));

  // And the guard really is the thing standing between the two: what it refuses
  // is exactly what the reader refuses, rather than a stricter limit that would
  // reject rosters the wire can carry.
  const w = new Writer(256);
  writeRoster(w, roster(MAX_LOBBY_SLOTS));
  const r = new Reader(w.finish());
  r.u8();
  r.u8();
  assert.equal(readRoster(r).slots.length, MAX_LOBBY_SLOTS);
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

test('every client-to-host lobby message is exactly the bytes the other side reads', () => {
  /*
   * These four have no reader in this package. `readRoster` exists because the host
   * broadcasts a roster and everyone parses it here, but Join, SetTeam,
   * SetReady and Welcome are read across the lane split. So the bytes are the
   * entire contract between the two, and a round-trip test cannot be written
   * for them: there is nothing on this side to round-trip against.
   *
   * Where those readers actually are, since the first version of this said
   * "handleLobbyPacket in the app's LobbySession" as though it were on main:
   *
   *   handleLobbyPacket   packages/app/src/net/lobby.ts, on the b/lobby branch
   *                       -- not merged, so searching main for it finds nothing
   *   game.js             LobbyOp.Roster and LobbyOp.Welcome only. It is only
   *                       ever a lobby client, so the three host-inbound ops
   *                       are ones it sends and never parses.
   *
   * Which means Join, SetTeam and SetReady have no reader on main at all right
   * now. That is the strongest reason to pin their layout here rather than a
   * reason not to.
   *
   * Which is how two of them ended up with no test at all. Sweeping core for
   * exported names that appear nowhere in this suite turned up
   * `writeLobbySetReady` and `writeLobbyWelcome`, both on the path between
   * "everyone is in the lobby" and "the match starts", and both used for real
   * -- the browser sends SetReady when you tap ready, and Welcome is the only
   * message that tells a client which row of the roster is theirs.
   *
   * So this pins the layout instead. It is a change-detector by design: if a
   * byte here moves, the reader across the split has to move with it, and this
   * test failing is the notice.
   */
  const bytes = (build: (w: InstanceType<typeof Writer>) => void, cap = 64) => {
    const w = new Writer(cap);
    build(w);
    return [...w.finish()];
  };

  assert.deepEqual(
    bytes((w) => writeLobbySetReady(w, true)),
    [LOBBY_MSG, LobbyOp.SetReady, 1],
    'ready',
  );
  assert.deepEqual(
    bytes((w) => writeLobbySetReady(w, false)),
    [LOBBY_MSG, LobbyOp.SetReady, 0],
    'not ready -- the flag has to be a byte, not merely something truthy',
  );

  assert.deepEqual(
    bytes((w) => writeLobbyWelcome(w, 0)),
    [LOBBY_MSG, LobbyOp.Welcome, 0],
    'welcome for the host seat',
  );
  // Every seat the lobby can hand out has to survive the trip, including the
  // last one -- a client told the wrong slotId drives somebody else's tank.
  for (let slot = 0; slot < MAX_LOBBY_SLOTS; slot++) {
    assert.deepEqual(
      bytes((w) => writeLobbyWelcome(w, slot)),
      [LOBBY_MSG, LobbyOp.Welcome, slot],
      `welcome for slot ${slot}`,
    );
  }

  assert.deepEqual(
    bytes((w) => writeLobbySetTeam(w, 7)),
    [LOBBY_MSG, LobbyOp.SetTeam, 7],
    'team change',
  );

  // Join carries a name, so only its head is fixed; the length-prefixed string
  // after it is already covered by the Writer's own tests.
  const join = bytes((w) => writeLobbyJoin(w, 'Forrest'));
  assert.deepEqual(join.slice(0, 2), [LOBBY_MSG, LobbyOp.Join], 'join header');

  // The four opcodes must stay distinct, or the reader dispatches on the wrong
  // one and the failure looks like a lobby that ignores you.
  const ops = [LobbyOp.Join, LobbyOp.SetTeam, LobbyOp.SetReady, LobbyOp.Welcome, LobbyOp.Roster];
  assert.equal(new Set(ops).size, ops.length, 'two lobby opcodes share a value');
});
