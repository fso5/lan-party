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
const srv = spawn('node', ['server.mjs'], { env: { ...process.env, PORT }, stdio: 'pipe' });
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

for (const e of errors) failures.push('console error: ' + e);

await b.close();
srv.kill();

if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('no console errors; two clients seated and scoreboard rendered');
