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

/*
 * Lets the phase below serve a second build without rebuilding anything. Set to
 * a function and every response passes through it.
 */
let redeploy = null;

const srv = createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (!p.startsWith(BASE)) { res.writeHead(404); res.end('not under the base path'); return; }
  p = p.slice(BASE.length - 1);
  if (p === '/') p = '/index.html';
  const file = join(root, p);
  if (!existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
  let body = readFileSync(file);
  if (redeploy) body = redeploy(p, body);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    // Pages sets no long TTL on these and neither should this. A cached sw.js
    // would hide the very update this is about to test.
    'Cache-Control': 'no-cache',
  });
  res.end(body);
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

  /*
   * Landscape, for the same reason and with the same blind spot.
   *
   * A home-screen launch is the only way anyone plays this without being told
   * to turn their phone: the page's own hint covers a browser tab, and cannot
   * cover an installed app because the manifest has already decided the
   * orientation by then. Nothing exercises that either -- Playwright loads
   * pages, it does not install apps -- so like start_url it is checked as
   * text, and losing it would be silent.
   *
   * A 24x14 arena upright is 16.3px tiles against 23px sideways, measured.
   */
  check(
    manifest.orientation === 'landscape',
    'the manifest asks for landscape, so an installed app opens the right way up',
    `orientation = ${JSON.stringify(manifest.orientation)}`,
  );
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

/*
 * Does an installed app ever get a fix?
 *
 * This is the whole update mechanism for the route that reaches an iPhone:
 * open the Pages URL once, add to home screen, and from then on every change
 * arrives through the service worker or not at all. A worker that never
 * replaces its cache leaves that player on the build they first installed,
 * permanently and silently -- they do not see a stale version, they see a game
 * that simply never improves.
 *
 * Nothing tested it. The offline checks above install a worker once and stop,
 * so a build that could never update passed them all.
 *
 * Simulated rather than rebuilt: the server rewrites sw.js so its cache name
 * differs, which is exactly what a real deploy does -- build-pwa hashes the
 * page into the cache name, so any content change produces a new one. A
 * browser only installs a new worker when sw.js differs byte for byte, so this
 * is the real trigger and not a shortcut past it.
 */
const oldCache = cached.cache;
const NEW_CACHE = `${oldCache}-next`;
redeploy = (path, body) => {
  if (path.endsWith('sw.js')) {
    return Buffer.from(body.toString().replaceAll(oldCache, NEW_CACHE));
  }
  if (path.endsWith('.html')) {
    return Buffer.from(body.toString().replace(/<title>[^<]*<\/title>/, '<title>Tanks! next</title>'));
  }
  return body;
};

await p.reload();

/*
 * Polled from out here rather than with waitForFunction and an async
 * predicate. The first version did the latter, and it reported success on the
 * very run whose own diagnostic line showed the old cache still in place: the
 * predicate returns a promise, and what the poller made of that was not what
 * it looked like. A check that can pass while the thing it checks is false is
 * worse than no check, so the await happens where its result is plainly a
 * value and the comparison happens in Node.
 */
let seenCaches = [];
for (let i = 0; i < 30; i++) {
  seenCaches = await p.evaluate(() => caches.keys());
  if (seenCaches.length === 1 && seenCaches[0] === NEW_CACHE) break;
  await p.waitForTimeout(500);
}
const swapped = seenCaches.length === 1 && seenCaches[0] === NEW_CACHE;

const afterUpdate = { caches: seenCaches };
console.log('after redeploy:', JSON.stringify(afterUpdate));
check(
  swapped,
  'a redeployed app replaces its cache instead of serving the old one forever',
  `caches now ${afterUpdate.caches.join(', ')}, wanted just ${NEW_CACHE}`,
);

// And the new bytes actually reach the player. The reload above was served
// cache-first from the old worker, so this is the visit after -- which is what
// a player gets the second time they open it.
await p.reload();
const title = await p.evaluate(() => document.title);
check(
  title === 'Tanks! next',
  'and the next launch serves the new build, not the cached old one',
  `title is ${JSON.stringify(title)}`,
);

/*
 * Put the real build back in the cache before the offline phase.
 *
 * Clearing `redeploy` alone is not enough and the first version of this got it
 * wrong: the worker serves cache-first, so the doctored page stays cached and
 * the offline checks below end up proving that *this test's rewrite* works
 * offline. The tell was the offline reload reporting `title: "Tanks! next"`.
 *
 * So this deploys a third time, with the real html and a third cache name --
 * the same mechanism again, which also happens to prove it twice.
 */
const FINAL_CACHE = `${oldCache}-real`;
redeploy = (path, body) =>
  path.endsWith('sw.js') ? Buffer.from(body.toString().replaceAll(oldCache, FINAL_CACHE)) : body;

await p.reload();
for (let i = 0; i < 30; i++) {
  const keys = await p.evaluate(() => caches.keys());
  if (keys.length === 1 && keys[0] === FINAL_CACHE) break;
  await p.waitForTimeout(500);
}
await p.reload();
const restored = await p.evaluate(() => document.title);
check(
  restored !== 'Tanks! next',
  'the offline phase below runs against the real build, not this test rewrite',
  `title is still ${JSON.stringify(restored)}`,
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
