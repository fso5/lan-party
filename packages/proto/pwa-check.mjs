/**
 * Proves the PWA actually works with the network gone.
 *
 * Loads the page, waits for the service worker to install, then blocks every
 * network request and reloads. If the game still renders and ticks, offline is
 * real rather than merely configured.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

function findChrome() {
  for (const d of readdirSync('/opt/pw-browsers')) {
    if (!d.startsWith('chromium-')) continue;
    for (const r of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = `/opt/pw-browsers/${d}/${r}`;
      if (existsSync(p)) return p;
    }
  }
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const root = new URL('./pwa/', import.meta.url).pathname;
const srv = createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = join(root, p);
  if (!existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => srv.listen(8099, r));

const b = await chromium.launch({ executablePath: findChrome() });
const ctx = await b.newContext({ viewport: { width: 844, height: 390 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));

await p.goto('http://localhost:8099/');
await p.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15000 })
  .catch(() => console.log('  (worker did not take control in time)'));
const swState = await p.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { active: !!r?.active, scope: r?.scope };
});
console.log('service worker:', JSON.stringify(swState));

const cached = await p.evaluate(async () => {
  const names = await caches.keys();
  const c = await caches.open(names[0]);
  return { cache: names[0], entries: (await c.keys()).map(r => new URL(r.url).pathname) };
});
console.log('cached:', JSON.stringify(cached));

// Now cut the network entirely and reload.
await ctx.setOffline(true);
srv.close();
await p.reload();
await p.waitForTimeout(1500);

const offline = await p.evaluate(() => ({
  title: document.title,
  map: document.getElementById('map-name')?.textContent,
  tick: window.__state?.world?.tick ?? null,
  tanks: window.__state?.world?.tanks?.length ?? 0,
}));
console.log('OFFLINE reload:', JSON.stringify(offline));
console.log(offline.tick > 0 ? '>>> works with no network' : '>>> FAILED offline');
console.log(errs.length ? 'errors: ' + errs.join('; ') : 'no page errors');
await b.close();
