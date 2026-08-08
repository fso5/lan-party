/**
 * Two-client multiplayer smoke test.
 *
 * Launches the real server and two real browser pages, drives both, and checks
 * that each client's view of the other player's tank matches the host's. This
 * is the check that would catch a roster-ordering mistake -- where snapshots
 * apply to the wrong tank and everything looks fine until two people play.
 *
 * It also covers the round HUD, which no other test can reach: the scoreboard
 * is hidden in solo play, so every existing check runs with it switched off.
 *
 * Exits non-zero on failure. It used to print errors and exit 0, which meant a
 * completely broken multiplayer build still showed a green tick.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

import { lanAddress } from './lan-address.mjs';

/**
 * This container ships a Chromium at a fixed path; CI does not, and installs
 * one where Playwright expects it. Returning undefined there is correct -- but
 * readdirSync on a missing directory throws ENOENT, which would have made this
 * die on the first line in CI rather than fall back.
 */
function findChrome() {
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = `${root}/${dir}/${rel}`;
      if (existsSync(p)) return p;
    }
  }
}

/**
 * Port 8137, not 877.
 *
 * Anything below 1024 is privileged. This ran as root in the container it was
 * written in, so 877 bound fine; on a CI runner the bind fails with EACCES, the
 * server dies, and the symptom is the *browser* reporting connection refused --
 * which points at the test rather than at the port.
 */
const PORT = process.env.PORT || '8137';
// Not loopback: browsers treat localhost as a secure context and a phone's
// address is not, so a loopback-only test is easier than reality.
const HOST = lanAddress();
/*
 * Resolved against this file, not the shell's working directory.
 *
 * `spawn('node', ['server.mjs'])` works under `npm run mp:smoke`, which runs
 * from `packages/proto`, and dies from anywhere else -- including the repo
 * root, which is where anyone reaching for one suite in isolation stands. The
 * failure is `Cannot find module '<root>/server.mjs'` one second in, which
 * reads as the multiplayer test failing rather than as the harness not
 * finding its own server. Every other suite in here resolves off
 * `import.meta.url`; this one had been missed.
 */
const srv = spawn('node', [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  env: { ...process.env, PORT },
  stdio: 'pipe',
});
const srvLog = [];
srv.stdout.on('data', (d) => { srvLog.push(d.toString()); process.stdout.write('  [srv] ' + d); });
srv.stderr.on('data', (d) => { srvLog.push(d.toString()); process.stdout.write('  [srv!] ' + d); });
srv.on('exit', (code) => { if (code) srvLog.push(`server exited with code ${code}\n`); });

// Wait for the port to answer rather than for a guessed interval. A fixed sleep
// is a race that a cold CI runner loses -- server.mjs rebuilds the page before
// it listens -- and it fails as a browser error rather than as "server slow".
{
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (srv.exitCode !== null) {
      console.error('server exited before listening:\n' + srvLog.join(''));
      process.exit(1);
    }
    if (Date.now() > deadline) {
      console.error('server never listened within 60s:\n' + srvLog.join(''));
      srv.kill();
      process.exit(1);
    }
    try {
      const res = await fetch(`http://${HOST}:${PORT}/`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// The browser must not use this environment's HTTP proxy. It intercepts
// non-loopback addresses and answers the WebSocket upgrade with a 403, which
// has nothing to do with the game -- a phone talking to a phone has no proxy
// in the path. Loopback was bypassed automatically, which is part of why
// testing on localhost hid this whole class of difference.
const b = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-proxy-server'],
});
const errors = [];
const pages = [];
for (let i = 0; i < 2; i++) {
  const p = await b.newPage({ viewport: { width: 800, height: 500 } });
  p.on('pageerror', e => errors.push(`p${i}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`p${i}: ${m.text()}`); });
  await p.goto(`http://${HOST}:${PORT}/`);
  pages.push(p);
  await p.waitForTimeout(1200);
}

// Both drive and shoot for a few seconds.
for (const [i, p] of pages.entries()) {
  await p.mouse.move(400 + i * 100, 250);
  await p.keyboard.down(i === 0 ? 'd' : 'a');
}
await new Promise(r => setTimeout(r, 4000));
for (const [i, p] of pages.entries()) await p.keyboard.up(i === 0 ? 'd' : 'a');
await new Promise(r => setTimeout(r, 800));

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/*
 * Does a shot fired on one phone appear on the other?
 *
 * Nothing above this asks. The suite watched tanks converge and the scoreboard
 * render, both of which stayed true through a stretch where a client deleted
 * every shell it had not fired itself on the next reconciliation -- so the
 * opponent's shells were lethal and invisible and this run was green.
 *
 * Sampled over a window rather than once, because a shell is short-lived: it
 * can hit a wall a few frames after it is drawn, and a single snapshot taken
 * at the wrong moment would make this flap.
 */
const weapons = async (p) => p.evaluate(() => ({
  me: window.__net?.client?.localTankId ?? null,
  shells: (window.__state?.world?.shells ?? []).map((s) => s.ownerId),
  mines: (window.__state?.world?.mines ?? []).map((m) => m.ownerId),
}));

const idA = (await weapons(pages[0])).me;
const idB = (await weapons(pages[1])).me;

/*
 * Not checked here: whether the two screens agree about who is alive.
 *
 * It looks like the obvious next assertion and it is worthless. Both clients
 * run the same deterministic simulation over the same shells, so they arrive
 * at the same deaths on their own -- with the host's TankKilled event thrown
 * away entirely, and with snapshots forbidden from applying `alive` at all,
 * the two screens still agreed. Tried both as mutations; neither turned this
 * suite red.
 *
 * So an alive comparison here would read like coverage of the death path and
 * be measuring the physics instead. What actually guards that path is in
 * netcode.test.ts, where the client can be isolated from its own simulation.
 */

let aFiredSeenByB = 0;
let aMinedSeenByB = 0;
let aFiredSeenByA = 0;
let aMinedSeenByA = 0;

await pages[0].keyboard.press('Space'); // one mine, which sits still for five seconds
for (let i = 0; i < 24; i++) {
  if (i % 4 === 0) await pages[0].keyboard.press('Enter'); // and a shot every ~400ms
  await pages[0].waitForTimeout(100);
  const [wa, wb] = [await weapons(pages[0]), await weapons(pages[1])];
  aFiredSeenByA = Math.max(aFiredSeenByA, wa.shells.filter((o) => o === idA).length);
  aFiredSeenByB = Math.max(aFiredSeenByB, wb.shells.filter((o) => o === idA).length);
  aMinedSeenByA = Math.max(aMinedSeenByA, wa.mines.filter((o) => o === idA).length);
  aMinedSeenByB = Math.max(aMinedSeenByB, wb.mines.filter((o) => o === idA).length);

}

console.log(
  `A drives tank ${idA}, B drives tank ${idB}; ` +
  `A's shells seen — on A ${aFiredSeenByA}, on B ${aFiredSeenByB}; ` +
  `A's mines — on A ${aMinedSeenByA}, on B ${aMinedSeenByB}`,
);
check(aFiredSeenByA > 0, 'A never drew its own shell, so the rest of this proves nothing');
check(aFiredSeenByB > 0, "A's shells never reached B — lethal on the host, invisible on the other phone");
check(aMinedSeenByA > 0, 'A never laid its own mine');
check(aMinedSeenByB > 0, "A's mine never reached B");

const snap = async (p) => p.evaluate(() => ({
  status: document.getElementById('net-status').textContent,
  roundsVisible: !document.getElementById('rounds').hidden,
  roundLabel: document.getElementById('round-label').textContent,
  chips: [...document.querySelectorAll('#scoreboard li')].map((li) => li.textContent),
  mine: document.querySelectorAll('#scoreboard li[data-you="true"]').length,
  tick: window.__state?.world?.tick ?? null,
  tanks: (window.__state?.world?.tanks ?? []).map(t => [t.id, +t.x.toFixed(3), +t.y.toFixed(3), t.alive]),
}));

const a = await snap(pages[0]);
const c = await snap(pages[1]);
console.log('client A:', a.status, 'tick', a.tick, JSON.stringify(a.tanks));
console.log('client B:', c.status, 'tick', c.tick, JSON.stringify(c.tanks));

if (a.tanks.length && c.tanks.length) {
  let worst = 0, worstId = null;
  for (const [id, x, y] of a.tanks) {
    const other = c.tanks.find(t => t[0] === id);
    if (!other) continue;
    const d = Math.hypot(x - other[1], y - other[2]);
    if (d > worst) { worst = d; worstId = id; }
  }
  console.log(`worst cross-client disagreement: ${worst.toFixed(3)} tiles (tank ${worstId})`);
}
// The scoreboard only exists in a networked match, so this is the one place it
// is ever rendered. Without these assertions the HUD could be blank and the
// run would still pass on "no console errors".
for (const [label, s] of [['A', a], ['B', c]]) {
  check(/^player \d/.test(s.status), `${label}: never seated (status "${s.status}")`);
  check(s.roundsVisible, `${label}: round HUD hidden in a networked match`);
  check(/^(Round \d+|Final)$/.test(s.roundLabel), `${label}: bad round label "${s.roundLabel}"`);
  check(s.chips.length >= 2, `${label}: scoreboard shows ${s.chips.length} teams, expected >= 2`);
  check(s.mine === 1, `${label}: ${s.mine} rows marked as yours, expected exactly 1`);
}
console.log('scoreboard A:', JSON.stringify(a.chips), 'label', a.roundLabel);
console.log('scoreboard B:', JSON.stringify(c.chips), 'label', c.roundLabel);

/*
 * A second round, which nothing has ever checked.
 *
 * The server had no `roundBuilder`, so a MatchHost with no way to build a
 * second world declared the match over after one round -- while the browser
 * sat there showing a best-of-three scoreboard. That also meant the round
 * transition was untested on both sides, and it is the most intricate thing a
 * host does: build a new world, reseat everyone, and send a fresh MatchStart
 * while the clock keeps running.
 *
 * Asserted on both clients, because the interesting half is the *client*:
 * `net.dispatch` has to notice a MatchStart arriving long after MatchClient
 * took over and rebuild the world from it. If it forwarded that packet to
 * MatchClient like any other, the phone would keep simulating the round that
 * already ended.
 *
 * The bots resolve a round in roughly six seconds of game time on their own,
 * with these clients pressing nothing. Twenty-five is slack, not an
 * expectation.
 */
/*
 * Asserted on living tanks, NOT on the round label.
 *
 * "Round 2" is a client-side counter that advances when round one *ends*, and
 * it advances just the same when the host had no way to build a second world
 * and declared the match over instead. The first version of this check waited
 * for that label and passed with `roundBuilder` removed -- it was reading the
 * counter, not the round.
 *
 * A real new round is visible in the world: round one ends with at most one
 * tank standing, and the rebuild brings them all back. So wait for the wipeout
 * first and the recovery second. Neither half alone means anything -- the
 * arena starts full, so "three alive" is the opening position too.
 */
const alive = 'window.__state?.world?.tanks.filter((t) => t.alive).length ?? 0';
const roundTwo = async (p, label) => {
  const ended = await p
    .waitForFunction(`(${alive}) <= 1`, null, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  check(ended, `${label}: round one never resolved, so there was nothing to rebuild`);
  const rebuilt = await p
    .waitForFunction(`(${alive}) >= 3`, null, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  const now = await p.evaluate(() => ({
    label: document.getElementById('round-label').textContent,
    tick: window.__state?.world?.tick ?? null,
    alive: window.__state?.world?.tanks.filter((t) => t.alive).length ?? 0,
  }));
  check(
    rebuilt,
    `${label}: the world was never rebuilt for a second round ` +
      `(${now.alive} tanks alive, label "${now.label}")`,
  );
  return now;
};
// Both watched at once, not one after the other. Waiting on A first spends
// twenty seconds of wall clock, and B's wipeout happens during it -- so B was
// already back in a full arena by the time anyone looked, and the run failed
// claiming B's round one "never resolved" when it had resolved and rebuilt
// while the test was busy.
const [r2a, r2b] = await Promise.all([roundTwo(pages[0], 'A'), roundTwo(pages[1], 'B')]);
console.log(`round two: A "${r2a.label}" tick ${r2a.tick} ${r2a.alive} alive, B "${r2b.label}" tick ${r2b.tick} ${r2b.alive} alive`);

/*
 * And the new world has to be the *host's* new world. The round-two MatchStart
 * carries a different seed from round one -- replaying the same seed would be
 * the same fight three times -- so a client that rebuilt from a stale seed is
 * running a different match while looking perfectly healthy. Both clients
 * agreeing on tank positions is what rules that out.
 */
const after = await Promise.all(pages.map(snap));
if (after[0].tanks.length && after[1].tanks.length) {
  let worst = 0;
  for (const [id, x, y] of after[0].tanks) {
    const other = after[1].tanks.find((t) => t[0] === id);
    if (!other) continue;
    worst = Math.max(worst, Math.hypot(x - other[1], y - other[2]));
  }
  console.log(`round two cross-client disagreement: ${worst.toFixed(3)} tiles`);
  check(worst < 1.5, `the two clients disagree by ${worst.toFixed(2)} tiles after the round rebuild`);
}

/*
 * The connection numbers have to be the real ones.
 *
 * smoke.mjs already checks the readout opens and carries a live tick, but it
 * runs solo, where there is no MatchClient and the netcode half is absent by
 * design -- its comment says so. So `snap`, `stale`, `reconcile`, `resync` and
 * `err` were displayed by code nothing had ever read. Replacing the whole
 * snap/stale fragment with a hardcoded zero survived every suite.
 *
 * That is worse than an untested feature. The README points somebody at these
 * numbers for exactly the situation where nothing else is available -- a
 * hotspot, two phones, no laptop -- and tells them zero snapshots means
 * nothing is arriving from the host. A readout stuck at zero would send them
 * chasing a network that is working perfectly well.
 *
 * Only `snap` is asserted to have moved, and the rest are left alone because
 * they are not stable enough to assert either way. A healthy local run here
 * reads `snap 132 stale 2 reconcile 5 resync 0 err 0.000` -- so stale and
 * reconcile are small but not zero, and pinning either direction would be
 * pinning scheduler noise. Snapshots applied is the one that cannot be zero
 * while a client is visibly playing, which is what makes it worth asserting.
 */
{
  const readout = async (p) => {
    await p.click('#btn-build');
    await p.waitForTimeout(250);
    const text = await p.locator('#debug').textContent();
    await p.click('#btn-build');
    return text ?? '';
  };
  const text = await readout(pages[0]);
  console.log('client A diagnostics:', JSON.stringify(text));
  check(/snap \d+/.test(text), `the readout carries the netcode numbers, got "${text}"`);
  const applied = Number(text.match(/snap (\d+)/)?.[1] ?? 0);
  check(
    applied > 0,
    `a seated client has applied snapshots, but the readout says ${applied}`,
  );
}

for (const e of errors) failures.push('console error: ' + e);

await b.close();
srv.kill();

if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('no console errors; two clients seated and scoreboard rendered');
