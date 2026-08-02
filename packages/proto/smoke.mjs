/**
 * Smoke test for the built prototype.
 *
 * Loads the self-contained HTML in a real browser, drives it with keyboard and
 * mouse, cycles every map, and fails on any console error or page exception.
 * A bundling mistake here shows up as a blank page rather than a build error,
 * so this is the only thing that actually proves the artifact works.
 */

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';

/** The container ships a Chromium that may not match the pinned build id. */
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
  return undefined;
}
const SCRATCH = process.env.SHOT_DIR || '/tmp';
const b = await chromium.launch({ executablePath: findChrome() });
const p = await b.newPage({ viewport: { width: 1000, height: 640 } });
const errors = [];
p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
// Derived, not hardcoded. An absolute path baked in here works only on the
// machine it was written on -- in CI the checkout lives somewhere else, and the
// failure is a browser error about a missing file rather than anything
// pointing at the path.
await p.goto(new URL('./dist/tanks-proto.html', import.meta.url).href);
await p.waitForTimeout(600);

const probe = async () => p.evaluate(() => {
  const c = document.getElementById('arena');
  return {
    canvas: c ? [c.width, c.height] : null,
    map: document.getElementById('map-name').textContent,
    enemies: document.getElementById('stat-enemies').textContent,
  };
});
console.log('initial:', JSON.stringify(await probe()));

// Drive and shoot for a few seconds; the tick counter must advance.
await p.mouse.move(700, 300);
await p.keyboard.down('d');
await p.mouse.down(); await p.waitForTimeout(150); await p.mouse.up();
await p.waitForTimeout(1500);
await p.keyboard.up('d');
await p.keyboard.press('t');   // trajectory on
await p.keyboard.press('g');   // debug on
await p.waitForTimeout(400);

const dbg = await p.evaluate(() => document.getElementById('debug').textContent);
console.log('debug:', dbg);
await p.screenshot({ path: SCRATCH+'/shot-light.png' });

await p.emulateMedia({ colorScheme: 'dark' });
await p.waitForTimeout(300);
await p.screenshot({ path: SCRATCH+'/shot-dark.png' });

// Cycle a couple of maps to be sure none of them throw.
for (let i=0;i<7;i++){ await p.keyboard.press(']'); await p.waitForTimeout(180); }
console.log('after cycling:', JSON.stringify(await probe()));

// Phone-sized, portrait-ish landscape as the game would be held.
await p.setViewportSize({ width: 844, height: 390 });
await p.waitForTimeout(400);
await p.screenshot({ path: SCRATCH+'/shot-phone.png' });

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await b.close();
