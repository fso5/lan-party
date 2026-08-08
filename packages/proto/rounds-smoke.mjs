/**
 * What the host puts on the wire: between rounds, between matches, and to a
 * room with more people in it than the map has places to stand.
 *
 * mp-smoke drives real browsers and checks the thing a player would notice --
 * the arena refills for round two. It cannot check what the round-two
 * `MatchStart` actually *says*, because both clients rebuild from the same
 * message: if the host announced a stale seed they would agree with each other
 * perfectly and disagree only with the host, which no cross-client comparison
 * can see. Their reconciliation counters cannot see it either -- the error
 * they report is for the local tank, which is idle, and snapshots quietly
 * correct the bots fifteen times a second. Verified by mutation: announcing
 * round one's seed for round two leaves mp-smoke entirely green.
 *
 * So this reads the wire instead. A raw WebSocket, no browser.
 *
 * A new *round* and a new *match* are told apart by `hostTick`: rounds carry
 * the clock forward deliberately, so a round-two announcement is ahead of round
 * one's, while a fresh match starts a fresh world at tick 0.
 *
 * Exits non-zero on failure.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Reader, MsgType, readMatchStart, loadArena, missionById } from '@tanks/core';

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

/**
 * Run a server, listen as one client, and collect every MatchStart it sends.
 *
 * `until` stops the wait early once enough have arrived, so the slow default
 * budget is only spent when something is wrong.
 */
async function collect({ port, env = {}, budgetMs, until, label, clients = 1 }) {
  const srv = spawn('node', [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: port, ...env },
    stdio: 'pipe',
  });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));

  // server.mjs rebuilds the page before it listens, so poll the port rather
  // than guess an interval -- a fixed sleep is a race a cold runner loses.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (srv.exitCode !== null) {
      console.error(`${label}: server exited before listening:\n` + log);
      process.exit(1);
    }
    if (Date.now() > deadline) {
      console.error(`${label}: server never listened within 60s:\n` + log);
      srv.kill();
      process.exit(1);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // One socket unless asked for more. Extra clients join one at a time, since
  // every join rebuilds the match and the last roster is the one that counts.
  const socks = [];
  const starts = [];
  for (let i = 0; i < clients; i++) {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.binaryType = 'arraybuffer';
    sock.on('message', (data) => {
      const r = new Reader(new Uint8Array(data));
      if (r.u8() !== MsgType.MatchStart) return;
      const s = readMatchStart(r);
      starts.push(s);
      if (clients === 1) {
        console.log(`  ${label} #${starts.length}: seed ${s.seed}, hostTick ${s.hostTick}, tank ${s.yourTankId}`);
      }
    });
    await new Promise((res) => sock.on('open', res));
    socks.push(sock);
    if (clients > 1) await new Promise((r) => setTimeout(r, 200));
  }

  const stopAt = Date.now() + budgetMs;
  while (Date.now() < stopAt && !until(starts)) await new Promise((r) => setTimeout(r, 250));

  for (const s of socks) s.close();
  srv.kill();
  return { starts, log };
}

/*
 * Round two, on the default rules.
 *
 * Nothing is ever pressed here; the bots resolve round one among themselves in
 * roughly six seconds of game time. Forty is slack for a loaded runner.
 */
const rounds = await collect({
  port: '8143',
  budgetMs: 40_000,
  until: (s) => s.length >= 2,
  label: 'round',
});

check(rounds.starts.length >= 1, 'no MatchStart at all -- the client was never seated');
check(rounds.starts.length >= 2, `round two never announced (${rounds.starts.length} MatchStart(s) in 40s)`);

if (rounds.starts.length >= 2) {
  const [one, two] = rounds.starts;
  /*
   * A different seed, because the same one replays the same round. A bot match
   * is deterministic, so a best-of-three on one seed is the identical fight
   * three times -- and, worse, the world the host built for round two would not
   * be the world this message describes.
   */
  check(
    two.seed !== one.seed,
    `both rounds announced seed ${one.seed} -- the client rebuilds a different world than the host runs`,
  );
  /*
   * And the clock carries forward. Ticks travel as 16 bits and clients expand
   * them against their own, so a round-two host tick at or behind round one's
   * makes every snapshot look ancient until the client happens to resync.
   */
  check(
    two.hostTick > one.hostTick,
    `round two announced hostTick ${two.hostTick}, not ahead of round one's ${one.hostTick}`,
  );
}

/*
 * And the end of a *match*, which is a different path from the end of a round.
 *
 * A won match leaves MatchHost stepping a world nobody can affect, and the
 * browser hides its Restart button while a match is running -- so without a
 * restart the deciding round is the last thing that ever happens, on every
 * phone, with no control on screen to do anything about it.
 *
 * `ROUNDS=1` because measurement said a real best-of-three is far too slow to
 * test: with one idle client and three bots on separate teams, round one
 * resolved in 6 seconds, round two took 70, and the match had not finished 150
 * seconds in.
 *
 * The tell is `hostTick` going back to 0. A new round carries the clock
 * forward on purpose, so a fresh zero is a fresh world -- a new match -- and
 * not another round of the old one.
 */
const matches = await collect({
  port: '8144',
  env: { ROUNDS: '1' },
  budgetMs: 40_000,
  until: (s) => s.length >= 2 && s.slice(1).some((m) => m.hostTick === 0),
  label: 'match',
});

const restarted = matches.starts.slice(1).filter((m) => m.hostTick === 0);
check(
  restarted.length >= 1,
  `no new match after the old one was won -- ${matches.starts.length} MatchStart(s), ` +
    `host ticks ${matches.starts.map((m) => m.hostTick).join(', ')}`,
);

/*
 * More people than the map has places to stand.
 *
 * `spawnIndex` is a plain index into the arena's spawn list, and `createWorld`
 * falls back to `spawns[0]` when it is out of range -- so a roster that seats
 * more players than the map has starts puts two tanks on one square, and every
 * client rebuilds that same stacked world from the broadcast roster. Measured
 * before the cap: nine sockets on an eight-spawn map produced a roster whose
 * ninth player carried spawnIndex 8.
 *
 * Nine, because eight is the largest versus map's capacity and the bug needs
 * exactly one more than fits.
 */
const crowd = await collect({
  port: '8145',
  clients: 9,
  budgetMs: 6_000,
  until: (s) => s.length >= 9,
  label: 'crowd',
});

const roster = crowd.starts[crowd.starts.length - 1];
check(!!roster, 'nobody was seated at all with nine clients connected');
if (roster) {
  const idx = roster.players.map((p) => p.spawnIndex);
  console.log(`  crowd: 9 clients -> ${roster.players.length} players, spawn indices ${idx.join(',')}`);
  check(
    new Set(idx).size === idx.length,
    `two players share a spawn index (${idx.join(',')}) -- they would stand on the same square`,
  );
  /*
   * Bounded against the *map*, not against the roster.
   *
   * The first version of this check read `i < roster.players.length`, and that
   * bound grows with the bug: nine seated players carry indices 0-8, every one
   * of them "in range" of a nine-long roster. It survived the mutation it was
   * written for. The roster carries `mapId`, so the real bound is one lookup
   * away.
   */
  const arena = loadArena(missionById(roster.mapId));
  check(
    idx.every((i) => i < arena.spawns.length),
    `a player was given spawn index ${Math.max(...idx)} on "${arena.name}", ` +
      `which has ${arena.spawns.length} spawns -- createWorld falls back to spawns[0] and they stack`,
  );
}

if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  console.error('server said:\n' + rounds.log + matches.log + crowd.log);
  process.exit(1);
}
console.log(
  'rounds smoke passed: round two carried its own seed and the clock forward, ' +
    'a won match started a fresh one, and a crowd was seated without stacking',
);
