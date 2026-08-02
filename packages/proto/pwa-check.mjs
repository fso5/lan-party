/**
 * Proves the PWA actually works with the network gone.
 *
 * Loads the page, waits for the service worker to install, then blocks every
 * network request and reloads. If the game still renders and ticks, offline is
 * real rather than merely configured.
 *
 * This is the "add to home screen, works on a train" path, and until now
 * nothing ran it in CI -- `pages.yml` builds the PWA and deploys it without
 * ever loading it. A service worker that caches the wrong thing deploys green
 * and fails as a blank page, on the one occasion the player has no network to
 * retry with.
 *
 * Runs in `web.yml` rather than in the deploy, deliberately: it needs a
 * browser download, which is the flakiest thing in this repo's CI, and the
 * delivery path must not go red because a Chromium mirror was slow.
 *
 * `localhost` is not laziness here, unlike in the other smokes. Service
 * workers require a secure context, and a browser grants that to localhost and
 * to HTTPS -- which is Pages. A phone loading the game from another phone's
 * hotspot over plain http gets no service worker at all, and does not need
 * one: it is being handed the page by the host.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * The container ships a Chromium at a fixed path; CI does not, and installs one
 * where Playwright expects it. Returning undefined there is correct -- but
 * `readdirSync` on a missing directory throws ENOENT, which would kill this on
 * its first line in CI rather than fall back.
 */
function findChrome() {
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    if (!d.startsWith('chromium-')) continue;
    for (const r of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = `${root}/${d}/${r}`;
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const failures = [];
function check(ok, what, detail) {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` -- ${detail}` : ''}`);
    failures.push(what);
  }
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const root = new URL('./pwa/', import.meta.url).pathname;

/*
 * Served under a subpath, because that is where it actually lives.
 *
 * GitHub Pages puts a project site at `/<repo>/`, not at the root. Serving from
 * `/` here made the test easier than the deployment in a way that hides a whole
 * class of mistake: one absolute path -- `/index.html` in the precache list, a
 * `start_url` of `/` -- resolves correctly at the root and points at somebody
 * else's site on Pages. `caches.addAll` would reject, the service worker would
 * never install, and "add to home screen, works offline" would fail silently on
 * the one route an iPhone has.
 *
 * Everything is relative today and this passes. The point is that it now stops
 * passing the day it is not.
 */
const BASE = '/tanks-mobile/';
const srv = createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (!p.startsWith(BASE)) { res.writeHead(404); res.end('not under the base path'); return; }
  p = p.slice(BASE.length - 1);
  if (p === '/') p = '/index.html';
  const file = join(root, p);
  if (!existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => srv.listen(8099, r));

/*
 * The manifest, read rather than exercised.
 *
 * `start_url` and `scope` decide what a home-screen launch opens, which is the
 * one thing this test cannot drive -- Playwright loads a page, it does not
 * install an app. Absolute values here are correct at a domain root and wrong
 * on Pages, where they would send the tapped icon to somebody else's site, and
 * every runtime check below would still pass. So they are checked as text.
 */
{
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  for (const key of ['start_url', 'scope']) {
    const v = manifest[key];
    check(
      typeof v === 'string' && v.startsWith('.'),
      `the manifest's ${key} is relative, so it survives being served under a subpath`,
      `${key} = ${JSON.stringify(v)}`,
    );
  }
}

const b = await chromium.launch({ executablePath: findChrome() });
const ctx = await b.newContext({ viewport: { width: 844, height: 390 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));

await p.goto(`http://localhost:8099${BASE}`);
await p.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15000 })
  .catch(() => console.log('  (worker did not take control in time)'));
const swState = await p.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { active: !!r?.active, scope: r?.scope };
});
console.log('service worker:', JSON.stringify(swState));
check(swState.active, 'the service worker installed and became active');

const cached = await p.evaluate(async () => {
  const names = await caches.keys();
  const c = await caches.open(names[0]);
  return { cache: names[0], entries: (await c.keys()).map(r => new URL(r.url).pathname) };
});
console.log('cached:', JSON.stringify(cached));
// The page itself must be in the cache. Everything else is decoration; without
// this entry an offline reload has nothing to serve.
check(
  cached.entries.some((e) => e === BASE || e === `${BASE}index.html`),
  'the game page itself is cached, under the path it is served from',
  cached.entries.join(' '),
);

// Now cut the network entirely and reload.
await ctx.setOffline(true);
srv.close();
// A reload that cannot be served throws `net::ERR_FAILED` rather than
// returning, and an unhandled rejection here is the failure reported as a
// stack trace instead of as the sentence below -- which is the whole point of
// the test. Catch it and let the checks say what happened.
let reloadError = null;
try {
  await p.reload();
} catch (err) {
  reloadError = err instanceof Error ? err.message : String(err);
}
await p.waitForTimeout(1500);
check(!reloadError, 'the page reloads at all with the server gone', reloadError ?? '');

const offline = await p.evaluate(() => ({
  title: document.title,
  map: document.getElementById('map-name')?.textContent,
  tick: window.__state?.world?.tick ?? null,
  tanks: window.__state?.world?.tanks?.length ?? 0,
}));
console.log('OFFLINE reload:', JSON.stringify(offline));
// A tick above zero is the whole claim: the page loaded from cache, the bundle
// ran, and the simulation is advancing with the server shut down.
check(offline.tick > 0, 'the game runs with no network at all', `tick ${offline.tick}`);
check(offline.tanks > 0, 'and with a real world behind it', `${offline.tanks} tanks`);
check(errs.length === 0, 'no page errors offline', errs.join('; '));

await b.close();

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nworks with no network');
// Exits non-zero. It used to print ">>> FAILED offline" and exit 0, so a PWA
// that could not open without a network still showed a green tick.
if (failures.length) process.exit(1);
