/**
 * A real browser against the server the host phone actually runs.
 *
 * Every other browser test in this repo points Chromium at `server.mjs`, and
 * `server.mjs` is built out of `node:http` and the `ws` package. Neither of
 * those ships. The Android host serves the page and carries the game through
 * `LanHost`, on top of the HTTP parsing and WebSocket framing in
 * `packages/core/src/net/websocket.ts` -- code written here, from the RFC,
 * because a phone cannot install a dependency at a picnic table.
 *
 * So the split until now was: the code that ships was tested against Node's
 * WebSocket client (`wsinterop.test.ts`), and real browsers were tested against
 * code that does not ship. Nothing had ever put the two together. A handshake
 * detail Chromium insists on and undici tolerates would pass every check in
 * this repo and fail on the first phone.
 *
 * This closes that. `LanHost` over a real TCP socket, serving the real built
 * page, with a real browser loading it over plain HTTP and playing through it:
 *
 *   browser --- HTTP GET / -----------> LanHost      (our httpResponse)
 *   browser --- Upgrade: websocket ---> LanHost      (our handshakeResponse)
 *   browser <-- MatchStart, snapshots - MatchHost    (our encodeFrame)
 *   browser --- Input ----------------> MatchHost    (our WsDecoder)
 *
 * Plain HTTP and not HTTPS on purpose, because that is the deployment: an
 * HTTPS page may not open a `ws://` connection to a local IP, so the phone
 * serves the page itself rather than sending anyone to the cached PWA.
 *
 * Two clients rather than one. A second connection is what distinguishes a
 * decoder holding per-connection state from one holding it per process, and
 * one browser can never catch that.
 *
 * Exits non-zero on failure.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { requireFreshCore } from '../../tools/lib/fresh-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/*
 * Refuse a stale `dist` before importing anything out of it.
 *
 * This suite reads core through the package entry point, which is compiled
 * output, and that bit me while writing it: a mutation run left a broken
 * `acceptKey` in `dist` with clean source on disk. The next plain run failed
 * with "Incorrect 'Sec-WebSocket-Accept'", which reads exactly like a real
 * handshake bug in code that was in fact fine. Dynamic import, so the check
 * runs before the module is loaded rather than after hoisting.
 */
requireFreshCore(join(here, '..', '..'));

const {
  DEFAULT_MATCH_SIZE,
  DEFAULT_RULES,
  LanHost,
  MatchHost,
  TICK_HZ,
  VERSUS_BOT_KINDS,
  VERSUS_MAPS,
  Writer,
  createWorld,
  loadArena,
  writeMatchStart,
} = await import('@tanks/core');
const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

execFileSync('node', [join(here, 'build.mjs')], { stdio: 'inherit' });
const page = readFileSync(join(here, 'dist', 'tanks-proto.html'));

/**
 * The platform TCP listener, on Node instead of Kotlin.
 *
 * `LanHost` is written against this interface precisely so the half that is
 * hard to test -- accept, read, write, close -- is the only part that differs
 * between a phone and this script. Everything above it is the shipped code.
 */
function nodeTcpServer() {
  const socks = new Map();
  let handlers = null;
  let nextId = 1;
  let server = null;

  return {
    setHandlers(h) {
      handlers = h;
    },
    start(port) {
      return new Promise((resolve, reject) => {
        server = createServer((sock) => {
          const id = `c${nextId++}`;
          socks.set(id, sock);
          sock.on('data', (chunk) =>
            handlers?.onData(id, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
          );
          sock.on('close', () => {
            socks.delete(id);
            handlers?.onClose(id);
          });
          // A browser closing a tab resets rather than shutting down cleanly,
          // and an unhandled 'error' on a socket takes the process with it.
          sock.on('error', () => sock.destroy());
          handlers?.onConnection(id);
        });
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    stop() {
      for (const s of socks.values()) s.destroy();
      return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
    send(id, data) {
      socks.get(id)?.write(Buffer.from(data));
    },
    close(id) {
      socks.get(id)?.end();
    },
    getIpAddress: () => '127.0.0.1',
  };
}

const tcp = nodeTcpServer();
const host = new LanHost(tcp, { page, port: 0 });
const errors = [];
host.onError = (where, message) => errors.push(`${where}: ${message}`);

const joined = [];

/*
 * Count what the browsers send us, at the point our decoder finishes a message.
 *
 * `LanHost` calls `transport.receive` once per complete frame it has unmasked,
 * so a rising count here is proof of the inbound half: a browser always masks
 * its frames, and nothing else in this repo has ever put a real browser's
 * masking through `WsDecoder`. Wrapped rather than read off MatchHost, whose
 * per-client state is private -- and it must be wrapped before MatchHost is
 * constructed, since that is what installs the packet handler underneath.
 */
let framesIn = 0;
const realReceive = host.transport.receive.bind(host.transport);
host.transport.receive = (from, data) => {
  framesIn++;
  realReceive(from, data);
};

const port = await host.start();
console.log(`  LanHost listening on ${port}`);

/*
 * Rebuild the match whenever somebody arrives, the way server.mjs does.
 *
 * Not a lobby -- the point here is the transport underneath, and a match that
 * restarts on every join is the simplest thing that keeps everyone playing.
 */
const MAP = VERSUS_MAPS[0];
const arena = loadArena(MAP);
let match = null;
let matchHost = null;

function startMatch() {
  const peers = host.transport.peerIds;
  const seats = Math.min(peers.length, arena.spawns.length);
  const players = peers.slice(0, seats).map((_, i) => ({ team: i, spawnIndex: i }));
  const bots = [];
  const fillTo = Math.min(DEFAULT_MATCH_SIZE, arena.spawns.length);
  for (let s = players.length; s < fillTo; s++) {
    bots.push({ kind: VERSUS_BOT_KINDS[(s - players.length) % VERSUS_BOT_KINDS.length], team: s, spawnIndex: s });
  }
  const seed = 1000 + peers.length * 7;
  const world = createWorld({ arena, seed, players, bots });
  matchHost = new MatchHost(world, host.transport, DEFAULT_RULES);
  match = { mapId: MAP.id, seed, players, bots };

  peers.forEach((peerId, i) => {
    if (i >= seats) return;
    matchHost.addClient(peerId, i);
    const w = new Writer();
    writeMatchStart(w, { ...match, hostTick: matchHost.world.tick, yourTankId: i });
    host.transport.send(peerId, w.finish(), true);
  });
  console.log(`  match: ${players.length} player(s), ${bots.length} bot(s) [peers ${peers.join(',')}]`);
}

host.onPlayerJoin = (peer) => {
  joined.push(peer.id);
  startMatch();
};

/*
 * Fixed-rate host tick, the same shape as server.mjs: measure real elapsed
 * time and let MatchHost consume it in whole ticks, because setInterval drifts.
 */
const TICK_MS = 1000 / TICK_HZ;
let lastTick = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  const elapsed = now - lastTick;
  lastTick = now;
  matchHost?.update(elapsed);
}, TICK_MS);

/**
 * The same browser lookup the other suites use.
 *
 * A bare `chromium.launch()` resolves to the separate headless-shell build,
 * which is not always downloaded next to `chromium` -- it fails with
 * "Executable doesn't exist", which reads like a broken test rather than a
 * missing file. `--no-proxy-server` because the host here is 127.0.0.1 and an
 * outbound proxy will not reach it.
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
  return undefined;
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-proxy-server'] });
const openPage = async (label) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const pageErrors = [];
  p.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
  /*
   * Surface why a socket failed, because otherwise nothing does.
   *
   * A rejected handshake is silent from the page's side -- the socket simply
   * never opens -- and the host has already sent its response and moved on. The
   * browser is the only party that knows, and it says so here. Chromium's
   * "Incorrect 'Sec-WebSocket-Accept' header value" is what a wrong accept key
   * looks like, and without this line the whole suite just times out.
   */
  p.on('websocket', (ws) => {
    ws.on('socketerror', (e) => console.log(`    [${label}] websocket failed: ${e}`));
  });
  // Plain HTTP, from the host itself. This is the URL a player types.
  await p.goto(`http://127.0.0.1:${port}/`);
  return { p, pageErrors };
};

const a = await openPage('client A');
const b = await openPage('client B');

/**
 * Wait for a condition on the page, reporting what it actually saw on failure.
 *
 * Every wait here is on a socket that may simply never open: a rejected
 * handshake produces no error in the browser, the connection just does not
 * happen. So a timeout is the only way this fails rather than hangs.
 */
async function waitFor(p, label, fn, budgetMs = 20_000) {
  const stopAt = Date.now() + budgetMs;
  let last;
  while (Date.now() < stopAt) {
    last = await p.evaluate(fn);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(false, `${label}: never true within ${budgetMs / 1000}s (last saw ${JSON.stringify(last)})`);
  return null;
}

// The page came off our own HTTP response, not a dev server.
const title = await a.p.title();
check(/Tanks/i.test(title), `served page has title "${title}"`);

/*
 * Everything below asks `__net`, never `__state`.
 *
 * That distinction is the whole test, and it was not obvious: the page runs a
 * local single-player match the moment it loads, so `__state.world` exists and
 * its tick climbs with no network whatsoever. The first version of this file
 * asserted on exactly that and passed with the handshake deliberately broken --
 * measuring the offline game and calling it multiplayer.
 *
 * `net.client` is only ever assigned where a decoded MatchStart is handled, so
 * its existence cannot be produced by anything but a completed handshake and a
 * frame that arrived intact.
 */
await Promise.all([
  waitFor(a.p, 'client A joined the host', () => !!window.__net?.client),
  waitFor(b.p, 'client B joined the host', () => !!window.__net?.client),
]);

check(joined.length >= 2, `only ${joined.length} peer(s) completed the handshake`);

/*
 * And the traffic keeps coming, rather than one message having got through.
 *
 * `snapshotsApplied` is MatchClient's own count of snapshots decoded from the
 * wire -- fifteen a second when the link is healthy -- so a number that rises
 * over two seconds is continuous framing in both the host's encoder and the
 * browser's decoder.
 */
const snapsOf = (p) => p.evaluate(() => window.__net?.client?.snapshotsApplied ?? -1);
const before = await Promise.all([snapsOf(a.p), snapsOf(b.p)]);
await new Promise((r) => setTimeout(r, 2000));
const after = await Promise.all([snapsOf(a.p), snapsOf(b.p)]);
check(after[0] > before[0], `client A applied no new snapshots (${before[0]} -> ${after[0]})`);
check(after[1] > before[1], `client B applied no new snapshots (${before[1]} -> ${after[1]})`);

/*
 * The page agrees it is seated. `setNetStatus` writes "player N" only from the
 * MatchStart handler, so this is the visible half of the same fact -- what
 * somebody holding the phone would actually see.
 */
const status = await a.p.evaluate(() => window.__net?.status ?? null);
check(/^player \d+$/.test(status ?? ''), `client A shows net status "${status}", not a seat`);

/*
 * Traffic in the other direction too. Everything above is the host talking;
 * the host counts a peer's packets only when its own decoder unmasked them,
 * and a browser always masks -- the half a server-side round-trip never sees.
 */
const inboundBefore = framesIn;
await new Promise((r) => setTimeout(r, 1000));
check(
  framesIn > inboundBefore,
  `the host decoded no client frames in a second (${inboundBefore} -> ${framesIn}); ` +
    'nothing the browsers sent is getting through our decoder',
);

// A tab closing is the ordinary way a player leaves.
await b.p.context().close();
const gone = await (async () => {
  const stopAt = Date.now() + 10_000;
  while (Date.now() < stopAt) {
    if (host.transport.peerIds.length <= 1) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})();
check(gone, `client B closed its tab but the host still lists ${host.transport.peerIds.length} peer(s)`);

const stillPlaying = await (async () => {
  const t0 = await snapsOf(a.p);
  await new Promise((r) => setTimeout(r, 1000));
  return (await snapsOf(a.p)) > t0;
})();
check(stillPlaying, 'client A stopped receiving snapshots after the other client left');

check(a.pageErrors.length === 0, `client A page errors: ${a.pageErrors.join('; ')}`);
check(errors.length === 0, `LanHost reported: ${errors.join('; ')}`);

clearInterval(timer);
await browser.close();
await host.stop();

if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(
  'lanhost smoke passed: two real browsers loaded the page over plain HTTP from LanHost, ' +
    'completed our handshake, played through our framing, and one leaving did not disturb the other',
);
