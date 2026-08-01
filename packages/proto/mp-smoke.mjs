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

function findChrome() {
  const root = '/opt/pw-browsers';
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = `${root}/${dir}/${rel}`;
      if (existsSync(p)) return p;
    }
  }
}

const srv = spawn('node', ['server.mjs'], { env: { ...process.env, PORT: '877' }, stdio: 'pipe' });
srv.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
srv.stderr.on('data', d => process.stdout.write('  [srv!] ' + d));
await new Promise(r => setTimeout(r, 4000));

const b = await chromium.launch({ executablePath: findChrome() });
const errors = [];
const pages = [];
for (let i = 0; i < 2; i++) {
  const p = await b.newPage({ viewport: { width: 800, height: 500 } });
  p.on('pageerror', e => errors.push(`p${i}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`p${i}: ${m.text()}`); });
  await p.goto('http://localhost:877/');
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
