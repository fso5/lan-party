/**
 * What the host puts on the wire between rounds.
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
 * So this reads the wire instead. A raw WebSocket, no browser, one question:
 * does a second round arrive, and does it describe a different world?
 *
 * Exits non-zero on failure.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Reader, MsgType, readMatchStart } from '@tanks/core';

const PORT = process.env.PORT || '8143';
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

const srv = spawn('node', [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  env: { ...process.env, PORT },
  stdio: 'pipe',
});
let log = '';
srv.stdout.on('data', (d) => (log += d));
srv.stderr.on('data', (d) => (log += d));

// server.mjs rebuilds the page before it listens, so poll the port rather than
// guess an interval -- a fixed sleep is a race a cold runner loses.
{
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (srv.exitCode !== null) {
      console.error('server exited before listening:\n' + log);
      process.exit(1);
    }
    if (Date.now() > deadline) {
      console.error('server never listened within 60s:\n' + log);
      srv.kill();
      process.exit(1);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
sock.binaryType = 'arraybuffer';
const starts = [];
sock.on('message', (data) => {
  const r = new Reader(new Uint8Array(data));
  if (r.u8() !== MsgType.MatchStart) return;
  const s = readMatchStart(r);
  starts.push(s);
  console.log(`  MatchStart #${starts.length}: seed ${s.seed}, hostTick ${s.hostTick}, tank ${s.yourTankId}`);
});
await new Promise((res) => sock.on('open', res));

/*
 * Nothing is ever pressed here. The bots resolve round one among themselves in
 * roughly six seconds of game time; forty is slack for a loaded runner, and the
 * wait ends as soon as the second MatchStart lands.
 */
const deadline = Date.now() + 40_000;
while (starts.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));

check(starts.length >= 1, 'no MatchStart at all -- the client was never seated');
check(starts.length >= 2, `round two never announced (${starts.length} MatchStart(s) in 40s)`);

if (starts.length >= 2) {
  /*
   * A different seed, because the same one replays the same round. A bot match
   * is deterministic, so a best-of-three on one seed is the identical fight
   * three times -- and, worse, the world the host built for round two would not
   * be the world this message describes.
   */
  check(
    starts[1].seed !== starts[0].seed,
    `both rounds announced seed ${starts[0].seed} -- the client rebuilds a different world than the host runs`,
  );
  /*
   * And the clock carries forward. Ticks travel as 16 bits and clients expand
   * them against their own, so a round-two host tick at or behind round one's
   * makes every snapshot look ancient until the client happens to resync.
   */
  check(
    starts[1].hostTick > starts[0].hostTick,
    `round two announced hostTick ${starts[1].hostTick}, not ahead of round one's ${starts[0].hostTick}`,
  );
}

sock.close();
srv.kill();

if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  console.error('server said:\n' + log);
  process.exit(1);
}
console.log('rounds smoke passed: a second round was announced, with its own seed and the clock carried forward');
