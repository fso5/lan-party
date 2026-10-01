/**
 * The co-op campaign, with real browsers against the real host.
 *
 * `MODE=coop` server.mjs, two browsers, starting at mission 19 so a wipe has
 * somewhere visible to go: both phones must be seated on the players' team
 * against the mission's enemies, and when nobody is left -- the browsers press
 * nothing, so the enemies see to that -- both must move to mission 1, a
 * different map, and agree on it.
 *
 * Clearing a mission is the same transition in the other direction (coopNext
 * picks the mission, unit-tested in campaign-run.test.ts); this exercises the
 * part only real browsers can: a new map arriving between rounds.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

import { lanAddress } from './lan-address.mjs';

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

const PORT = process.env.PORT || '8139';
const HOST = lanAddress();
const START = 19;

const srv = spawn('node', [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  env: { ...process.env, PORT, MODE: 'coop', MISSION: String(START) },
  stdio: 'pipe',
});
const srvLog = [];
srv.stdout.on('data', (d) => { srvLog.push(d.toString()); process.stdout.write('  [srv] ' + d); });
srv.stderr.on('data', (d) => { srvLog.push(d.toString()); process.stdout.write('  [srv!] ' + d); });

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
      if ((await fetch(`http://${HOST}:${PORT}/`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// No proxy: see mp-smoke.mjs -- the environment's proxy refuses the upgrade.
const b = await chromium.launch({ executablePath: findChrome(), args: ['--no-proxy-server'] });
const errors = [];
const pages = [];
for (let i = 0; i < 2; i++) {
  const p = await b.newPage({ viewport: { width: 800, height: 500 } });
  p.on('pageerror', (e) => errors.push(`p${i}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`p${i}: ${m.text()}`); });
  await p.goto(`http://${HOST}:${PORT}/`);
  pages.push(p);
  await p.waitForTimeout(1200);
}

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

const view = (p) =>
  p.evaluate(() => {
    const w = window.__state.world;
    return {
      label: document.getElementById('round-label').textContent,
      map: document.getElementById('map-name').textContent,
      players: w.tanks.filter((t) => t.kind === 0).map((t) => t.team),
      enemies: w.tanks.filter((t) => t.kind !== 0).map((t) => t.team),
    };
  });

// Both browsers seated in the second MatchStart (the second join restarts the
// match), so wait for two player tanks on each.
for (const p of pages) {
  await p.waitForFunction(() => window.__state.world.tanks.filter((t) => t.kind === 0).length === 2, null, {
    timeout: 15_000,
  }).catch(() => {});
}
const first = await Promise.all(pages.map(view));
console.log('mission start:', JSON.stringify(first));
for (const [i, v] of first.entries()) {
  check(v.label === `Mission ${START}`, `p${i}: header reads "${v.label}", not "Mission ${START}"`);
  check(v.players.length === 2 && v.players.every((t) => t === 0), `p${i}: players not both on team 0 (${v.players})`);
  check(v.enemies.length > 0 && v.enemies.every((t) => t !== 0), `p${i}: no enemies, or an enemy on the players' team`);
}

// Nobody moves, so the mission's enemies wipe them out. That is a failed
// mission, and the campaign goes back to mission 1 -- a different map.
for (const p of pages) {
  await p
    .waitForFunction(() => document.getElementById('round-label').textContent === 'Mission 1', null, { timeout: 120_000 })
    .catch(() => {});
}
const after = await Promise.all(pages.map(view));
console.log('after the wipe:', JSON.stringify(after));
for (const [i, v] of after.entries()) {
  check(v.label === 'Mission 1', `p${i}: a wiped mission did not send the campaign back to mission 1 ("${v.label}")`);
  check(v.map !== first[i].map, `p${i}: the map did not change between missions (${v.map})`);
  check(v.players.length === 2, `p${i}: both players were not back for mission 1 (${v.players.length})`);
}
check(after[0].map === after[1].map, `the phones disagree on the map: ${after[0].map} / ${after[1].map}`);
check(errors.length === 0, `console errors: ${errors.join(' | ')}`);

await b.close();
srv.kill();

if (failures.length) {
  console.log('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('coop smoke passed: two phones on one team, a wiped mission sent both back to mission 1 on a new map');
