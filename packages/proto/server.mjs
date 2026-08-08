/**
 * Multiplayer test server.
 *
 * Runs the authoritative MatchHost in Node and relays binary packets to
 * browsers over WebSockets. This is a test harness for real devices, not a
 * shipping component -- the shipping game has no server at all, one of the
 * phones is the host.
 *
 * The point is that everything above the transport is identical to what will
 * run over Bluetooth: the same MatchHost, the same MatchClient, the same wire
 * protocol, the same 180-byte payload ceiling. Swapping WebSockets for BLE
 * later is a transport change and nothing else, which is exactly what we want
 * to have proven before touching a radio.
 *
 *   npm run mp --workspace @tanks/proto
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  BridgeTransport,
  MatchHost,
  DEFAULT_MATCH_SIZE,
  DEFAULT_RULES,
  VERSUS_BOT_KINDS,
  Writer,
  createWorld,
  loadArena,
  VERSUS_MAPS,
  writeMatchStart,
  TICK_HZ,
} from '@tanks/core';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);
const MAP = VERSUS_MAPS[Number(process.env.MAP || 0)] ?? VERSUS_MAPS[0];

execFileSync('node', [join(here, 'build.mjs')], { stdio: 'inherit' });
const html = readFileSync(join(here, 'dist', 'tanks-proto.html'));

const httpServer = createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
});

const wss = new WebSocketServer({ server: httpServer });

/** peerId -> socket. peerIds are assigned sequentially and never reused. */
const sockets = new Map();
let nextPeer = 1;

const transport = new BridgeTransport((to, data) => {
  const sock = sockets.get(to);
  if (sock && sock.readyState === sock.OPEN) sock.send(data);
});

let host = null;
let match = null;
let restartTimer = null;

/**
 * Rounds a side must win, overridable because a full best-of-three is long.
 *
 *   ROUNDS=1 npm run mp --workspace @tanks/proto
 *
 * Measured before adding this: with one idle client and three bots on separate
 * teams, round one resolved in 6 seconds and round two took 70, and a
 * best-of-three had not finished 150 seconds in. That is fine for playing and
 * useless for checking what happens at the *end* of a match, which is a
 * distinct code path from the end of a round.
 */
const RULES = { ...DEFAULT_RULES, roundsToWin: Number(process.env.ROUNDS || DEFAULT_RULES.roundsToWin) };

/** Long enough to read who won, short enough that nobody wanders off. */
const MATCH_OVER_PAUSE_MS = 5000;

/**
 * (Re)build the match around whoever is currently connected.
 *
 * Restarting on every join keeps the harness simple and always playable. A
 * real lobby would seat late joiners into the running match instead, but that
 * needs mid-match state sync, which is a different problem from the one this
 * server exists to test.
 */
function startMatch() {
  const arena = loadArena(MAP);
  const peers = [...sockets.keys()];

  /*
   * Only as many players as the map has places to put them.
   *
   * This used to seat every connected peer, and `spawnIndex` is a plain index:
   * with nine browsers on an eight-spawn map the ninth was handed index 8,
   * `createWorld` fell back to `spawns[0]`, and two tanks stood on one square
   * -- measured, not feared. Worse here than in the Bluetooth host, because the
   * roster is broadcast, so every client rebuilds the same stacked world.
   *
   * The extras stay connected and unseated rather than being disconnected;
   * `announce` already skips anyone past the roster, so they simply get no
   * MatchStart and sit on the waiting hint until a seat frees up and the next
   * join rebuilds the match.
   */
  const seats = Math.min(peers.length, arena.spawns.length);
  const players = peers.slice(0, seats).map((_, i) => ({ team: i, spawnIndex: i }));
  if (peers.length > seats) {
    console.log(`  ${peers.length - seats} peer(s) unseated: "${MAP.name}" has ${arena.spawns.length} spawns`);
  }

  // Top the match up with bots, so a solo tester still has something to shoot
  // at. Up to a good match size rather than up to the map's capacity -- the
  // maps carry eight starts so a full lobby has somewhere to stand, which is
  // not a reason to put seven bots in front of one tester.
  const botKinds = VERSUS_BOT_KINDS;
  const bots = [];
  const fillTo = Math.min(DEFAULT_MATCH_SIZE, arena.spawns.length);
  for (let s = players.length; s < fillTo; s++) {
    bots.push({ kind: botKinds[(s - players.length) % botKinds.length], team: s, spawnIndex: s });
  }

  const seed = 1000 + peers.length * 7;
  const world = createWorld({ arena, seed, players, bots });

  host = new MatchHost(world, transport, RULES);
  match = { mapId: MAP.id, seed, players, bots };

  /*
   * Play again, rather than leaving everyone on a finished match.
   *
   * A won match leaves `MatchHost` stepping a world nobody can affect, and the
   * browser hides its Restart button while a match is running -- so the round
   * that decided it was the last thing that ever happened, on every phone, with
   * no control on screen to do anything about it. "Restarting keeps the harness
   * always playable" is this file's own principle; it just did not cover the
   * one ending it cannot recover from.
   *
   * A pause first, so the result is readable rather than snatched away.
   */
  host.onMatchOver = () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (sockets.size > 0) startMatch();
    }, MATCH_OVER_PAUSE_MS);
  };

  /*
   * Rounds, because "everything above the transport is identical" has to
   * include them.
   *
   * Without a `roundBuilder` a MatchHost plays exactly one round and then
   * declares the match over -- a truthful outcome, and one this harness was
   * quietly living with while the browser showed a best-of-three scoreboard.
   * It also meant nothing here exercised the round transition, which is the
   * most intricate thing a host does: build a new world, reseat everyone, and
   * tell them, all while the clock keeps running. The app's own host
   * (HostScreen) does all three; this now does the same, so the two agree.
   *
   * A new seed per round. Reusing it replays the same round, and a bot match
   * is deterministic, so a best-of-three would be the same fight three times.
   *
   * `match` is rewritten with that seed, and it has to be: `announce` sends
   * `{...match}`, so leaving the original seed in there ships the client a
   * world built from different numbers than the host's. Measured before it was
   * fixed -- both MatchStarts went out reading seed 1007 while round two was
   * running on 1209, which is every bot diverging on its first decision.
   */
  host.roundBuilder = (round) => {
    match = { ...match, seed: seed + round * 101 };
    return createWorld({ arena, seed: match.seed, players, bots });
  };

  /*
   * Reseat and re-announce. A new world means new tank objects, so a client
   * holding the old ids is driving nothing -- and `MatchStart` is the only
   * thing that tells it otherwise. `removeClient` first because the old slots
   * point into the world that just ended.
   */
  host.onRoundStart = (w, round) => {
    for (const peerId of [...sockets.keys()]) host.removeClient(peerId);
    announce(w);
    console.log(`  round ${round}`);
  };

  announce(world);
  console.log(`  match started: ${peers.length} player(s), ${bots.length} bot(s) on "${MAP.name}"`);
}

/**
 * Seat every connected peer in the current world and tell them about it.
 *
 * Players are created before bots and in peer order, so peer `i` owns tank
 * `i` -- the same assumption `startMatch` builds the roster on, kept in one
 * place now that a round rebuild needs it too.
 */
function announce(world) {
  [...sockets.keys()].forEach((peerId, i) => {
    if (i >= match.players.length) return;
    host.addClient(peerId, i);
    const w = new Writer(64);
    // Include the host's current tick so the client can start its clock ahead
    // of ours rather than at zero -- a client running behind the host can never
    // apply a snapshot.
    writeMatchStart(w, { ...match, hostTick: world.tick, yourTankId: i });
    const sock = sockets.get(peerId);
    if (sock && sock.readyState === sock.OPEN) sock.send(w.finish());
  });
}

wss.on('connection', (sock) => {
  const peerId = `p${nextPeer++}`;
  sockets.set(peerId, sock);
  sock.binaryType = 'nodebuffer';
  transport.addPeer({ id: peerId, name: peerId, rtt: -1 });
  console.log(`  + ${peerId} connected (${sockets.size} total)`);

  sock.on('message', (data) => {
    // ws hands us a Buffer; the protocol reader wants a plain Uint8Array view.
    transport.receive(peerId, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  });

  sock.on('close', () => {
    sockets.delete(peerId);
    transport.removePeer(peerId);
    console.log(`  - ${peerId} left (${sockets.size} total)`);
    if (sockets.size > 0) startMatch();
    else host = null;
  });

  sock.on('error', () => sock.close());

  startMatch();
});

// Fixed-rate host tick. setInterval drifts, so measure real elapsed time and
// let MatchHost consume it in whole ticks -- the same thing the app does with
// requestAnimationFrame.
const TICK_MS = 1000 / TICK_HZ;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const elapsed = now - last;
  last = now;
  if (host) host.update(elapsed);
}, TICK_MS);

httpServer.listen(port, '0.0.0.0', () => {
  const addrs = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log(`\n  Tanks! multiplayer  —  "${MAP.name}"\n`);
  for (const a of addrs) console.log(`  phone    http://${a}:${port}`);
  console.log(`  local    http://localhost:${port}`);
  console.log('\n  Open on each phone. Same WiFi. Ctrl-C to stop.\n');
});
