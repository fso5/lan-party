/**
 * Does b/lobby's LobbySession seat real browsers over the transport that ships?
 *
 * Issue #9 finding 3 asked Session B to keep `LobbySession` transport-agnostic
 * so it works over `LanHost` as well as `BleTransport` -- "what makes teams
 * real for iPhones rather than only for Android-to-Android". I had checked that
 * over a `LoopbackTransport`, which proves the interfaces line up and nothing
 * about whether a browser can actually play along.
 *
 * This is the real thing: their session, unmodified, driving the same
 * BridgeTransport-over-WebSocket that `server.mjs` hosts a match on, with real
 * Chromium pages running the shipped game page.
 *
 * Not part of `smoke:all`, and it cannot be: `LobbySession` lives on `b/lobby`
 * and is not on main. The script fetches it from the branch itself, so it needs
 * no setup beyond the branch existing:
 *
 *     node tools/lobby-over-wifi.mjs                 # four seats, with churn
 *     PLAYERS=Alpha node tools/lobby-over-wifi.mjs   # the goal: two phones
 *
 * The two-seat run is the one that matters most -- one phone hosting, one
 * joining -- and it passes clean. The four-seat run adds a departure, which is
 * the only thing that provokes the seating bug.
 *
 * It reads their file and never writes to it.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { requireFreshCore } from './lib/fresh-core.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

// This runs their lobby against *our* core, and the core it reaches is
// packages/core/dist. See tools/lib/fresh-core.mjs: a stale one turns "their
// code works against ours" into a claim about a build nobody is running.
requireFreshCore(repo);
const proto = join(repo, 'packages', 'proto');

// Their file, straight off the branch, transpiled but otherwise untouched --
// so a passing run says something about their code and not my paraphrase of it.
// Inside the workspace, not a temp dir: the transpiled module imports
// `@tanks/core`, which only resolves from somewhere npm linked it.
const ts = join(proto, '.lobby-over-wifi.ts');
writeFileSync(ts, execFileSync('git', ['show', 'origin/b/lobby:packages/app/src/net/lobby.ts'], {
  cwd: repo, encoding: 'utf8',
}));
const mjs = join(proto, '.lobby-over-wifi.mjs');
execFileSync('npx', ['esbuild', ts, '--format=esm', '--target=es2022', `--outfile=${mjs}`], {
  cwd: proto, stdio: 'pipe',
});

execFileSync('node', [join(proto, 'build.mjs')], { stdio: 'pipe' });
const html = readFileSync(join(proto, 'dist', 'tanks-proto.html'));

const {
  BridgeTransport, MatchHost, Writer, createWorld, loadArena, VERSUS_MAPS,
  writeMatchStart, TICK_HZ,
} = await import('@tanks/core');
const { LobbySession } = await import(mjs);
const cleanup = () => { for (const f of [ts, mjs]) rmSync(f, { force: true }); };
process.on('exit', cleanup);

function findChrome() {
  const root = '/opt/pw-browsers';
  for (const dir of existsSync(root) ? readdirSync(root) : []) {
    if (!dir.startsWith('chromium-')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = `${root}/${dir}/${rel}`;
      if (existsSync(p)) return p;
    }
  }
}

const failures = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : ` -- ${detail}`}`);
  if (!ok) failures.push(what);
};

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
});
const wss = new WebSocketServer({ server: httpServer });

const sockets = new Map();
let nextPeer = 1;

// The same transport server.mjs hosts a match on. LobbySession only ever sees
// the Transport interface, which is the whole question.
const transport = new BridgeTransport((to, data) => {
  const s = sockets.get(to);
  if (s && s.readyState === s.OPEN) s.send(data);
});

const session = new LobbySession(transport, 'Host');
// `onChange` is a settable field and state is read through `get()`, not a
// public `state` property. Reading their API rather than guessing at it.
let changes = 0;
session.onChange = () => { changes++; };

wss.on('connection', (sock) => {
  const id = `p${nextPeer++}`;
  sockets.set(id, sock);
  sock.binaryType = 'arraybuffer';
  sock.on('message', (data) => transport.receive(id, new Uint8Array(data)));
  sock.on('close', () => {
    sockets.delete(id);
    transport.removePeer(id, 'closed');
  });
  transport.addPeer({ id, name: id, rtt: -1 });
});

await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
const port = httpServer.address().port;

await session.startHosting('WiFi lobby');
console.log(`hosting on ${port}; roster after startHosting:`,
  JSON.stringify(session.get().roster.slots.map((s) => `${s.name}=t${s.team}`)));

const browser = await chromium.launch({ executablePath: findChrome() });
const pages = [];
const NAMES = (process.env.PLAYERS || 'Alpha,Bravo,Cass').split(',').filter(Boolean);
for (const name of NAMES) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript((n) => localStorage.setItem('tanks.name', n), name);
  await p.goto(`http://127.0.0.1:${port}/`);
  pages.push({ p, ctx, name });
}

const rosterOf = (p) =>
  p.evaluate(() => [...document.querySelectorAll('#lobby-slots li')].map((li) => ({
    who: li.querySelector('.who')?.textContent,
    tag: li.querySelector('.tag')?.textContent,
  })));

console.log('\n-- does the browser lobby appear off a real LobbySession roster? --');
for (const { p, name } of pages) {
  try {
    await p.waitForSelector('#match-lobby:not([hidden])', { timeout: 15_000 });
    check(true, `${name} sees the lobby`);
  } catch {
    check(false, `${name} sees the lobby`, 'panel never appeared');
  }
}

await pages[0].p.waitForTimeout(600);
const seated = session.get().roster.slots.map((s) => `${s.name}=t${s.team}`);
console.log('\nhost-side roster:', JSON.stringify(seated));
check(session.get().roster.slots.length === NAMES.length + 1,
  `the host seated itself and all ${NAMES.length} browser(s)`,
  `${session.get().roster.slots.length} slot(s)`);

const rows = await rosterOf(pages[0].p);
check(rows.length === session.get().roster.slots.length,
  'the browser renders every seat the host has',
  `browser ${rows.length} vs host ${session.get().roster.slots.length}`);

/*
 * Finding 1 first, while the lobby is still seating people.
 *
 * Skipped in the two-seat case: with one client there is nobody to lose, and
 * the bug needs a departure. That case exists to prove the goal -- two phones,
 * one hosting -- reaches a match at all.
 *
 * Order matters here and I got it wrong once: run the leave-and-join after the
 * match has started and the roster is no longer being reseated, so the check
 * passes by reading the teams handed out before anybody left. It has to happen
 * while the lobby is the thing doing the work.
 */
const SKIP_FINDING_1 = NAMES.length < 2;
if (!SKIP_FINDING_1) console.log('\n-- finding 1, over the transport that actually ships --');
const teams = session.get().roster.slots.map((s) => s.team);
check(new Set(teams).size === teams.length,
  'free-for-all puts everyone on their own team',
  `teams ${JSON.stringify(teams)}`);

let live = pages;
if (!SKIP_FINDING_1) {
await pages[1].ctx.close();
await pages[0].p.waitForTimeout(600);

const late = await browser.newContext();
const lp = await late.newPage();
await lp.addInitScript(() => localStorage.setItem('tanks.name', 'Dre'));
await lp.goto(`http://127.0.0.1:${port}/`);
await lp.waitForSelector('#match-lobby:not([hidden])', { timeout: 15_000 }).catch(() => {});
await lp.waitForTimeout(600);

const after = session.get().roster.slots.map((s) => `${s.name}=t${s.team}`);
const afterTeams = session.get().roster.slots.map((s) => s.team);
console.log('after a leave and a join:', JSON.stringify(after));
check(new Set(afterTeams).size === afterTeams.length,
  'still one team each after somebody leaves and somebody joins',
  `teams ${JSON.stringify(afterTeams)} -- finding 1 reproduces over WiFi`);
live = [pages[0], pages[2], { p: lp, name: 'Dre' }];
}

console.log('\n-- ready up, and start the match the way HostScreen would have to --');

// Whoever is still seated taps Ready. The host is already ready: `seat` sets
// ready:true for it because it plays rather than serving.
for (const { p } of live) await p.click('#btn-ready');
await pages[0].p.waitForTimeout(800);

const readyStates = session.get().roster.slots.map((s) => `${s.name}:${s.ready ? 'ready' : 'not'}`);
console.log('  ', JSON.stringify(readyStates));
check(session.canStart(), 'canStart() goes true once every seat is ready',
  `roster ${JSON.stringify(readyStates)}`);

/*
 * The wiring LobbySession deliberately does not do.
 *
 * It stops at canStart() and peerForSlot() -- building the world and handing
 * out MatchStart is the screen's job, and no screen does it yet. This is that
 * glue, written the way server.mjs writes it, so the run says whether the rest
 * of the path holds once somebody writes it into HostScreen.
 */
let entered = 0;
if (session.canStart()) {
  const map = VERSUS_MAPS[0];
  const arena = loadArena(map);
  const slots = session.get().roster.slots;
  // Team comes from the lobby, which is the entire point of having one.
  const players = slots.map((s, i) => ({ team: s.team, spawnIndex: i }));
  const seed = 4242;
  const world = createWorld({ arena, seed, players, bots: [] });
  const host = new MatchHost(world, transport);
  const startMsg = { mapId: map.id, seed, players, bots: [] };

  slots.forEach((slot, i) => {
    const peer = session.peerForSlot(slot.slotId);
    if (!peer) return; // the host's own slot has no peer
    host.addClient(peer, i);
    const w = new Writer(64);
    writeMatchStart(w, { ...startMsg, hostTick: world.tick, yourTankId: i });
    const sock = sockets.get(peer);
    if (sock && sock.readyState === sock.OPEN) sock.send(w.finish());
  });

  // `update` takes real elapsed milliseconds; setInterval drifts, so measure
  // rather than assume the nominal interval, as server.mjs does.
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    host.update(now - last);
    last = now;
  }, 1000 / TICK_HZ);

  for (const { p, name } of live) {
    try {
      await p.waitForFunction(
        () => document.getElementById('match-lobby').hidden && !!window.__state?.world,
        { timeout: 10_000 },
      );
      const mine = await p.evaluate(() => ({
        tanks: window.__state.world.tanks.length,
        teams: [...new Set(window.__state.world.tanks.map((t) => t.team))].sort((a, b) => a - b),
      }));
      check(true, `${name} entered the match`, JSON.stringify(mine));
      entered++;
    } catch {
      check(false, `${name} entered the match`, 'still sitting in the lobby');
    }
  }
  clearInterval(timer);
}
check(entered === live.length, 'every browser made it from lobby to match',
  `${entered}/${live.length}`);

// The punchline. The match was built from the roster above, collision and all,
// so the lobby bug is not a cosmetic wrong label -- it reaches the world every
// player is now driving in.
if (entered) {
  const world = await live[0].p.evaluate(() => ({
    tanks: window.__state.world.tanks.length,
    teams: window.__state.world.tanks.map((t) => t.team),
  }));
  console.log(`\nthe match everyone is now in: ${world.tanks} tanks on teams ${JSON.stringify(world.teams)}`);
  check(new Set(world.teams).size === world.tanks,
    'and every tank in the running match is on its own team',
    `${new Set(world.teams).size} teams for ${world.tanks} tanks -- two players who cannot hurt each other`);
}

await browser.close();
httpServer.close();
wss.close();

console.log(failures.length ? `\nFAILED: ${failures.join('; ')}` : '\nall checks passed');
// Exit 0 either way. A failure here is a finding about an unmerged branch, not
// a broken main, and this is not wired into any suite that should go red for it.
process.exit(0);
