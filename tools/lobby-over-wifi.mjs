/**
 * Does the platform's LobbySession seat real browsers over the transport that
 * ships?
 *
 * The session is `@lan-party/lobby`'s, ported from `b/lobby` (PR #8) with the
 * fixes issue #9 asked for. This drives it over the same
 * BridgeTransport-over-WebSocket that `server.mjs` hosts a match on, with real
 * Chromium pages running the shipped Tanks page, then starts a match from the
 * roster it built.
 *
 *     node tools/lobby-over-wifi.mjs                 # four seats, with churn
 *     PLAYERS=Alpha node tools/lobby-over-wifi.mjs   # the goal: two phones
 *
 * The four-seat run adds a departure, which is what used to provoke the team
 * collision in issue #9.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { requireFreshCore } from './lib/fresh-core.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

// The core it reaches is games/tanks/core/dist. See tools/lib/fresh-core.mjs:
// a stale one turns a pass into a claim about a build nobody is running.
requireFreshCore(repo);
const page = join(repo, 'games', 'tanks');

execFileSync('node', [join(page, 'build.mjs')], { stdio: 'pipe' });
const html = readFileSync(join(page, 'dist', 'tanks-proto.html'));

const {
  BridgeTransport, MatchHost, Writer, createWorld, loadArena, VERSUS_MAPS,
  writeMatchStart, TICK_HZ,
} = await import('@lan-party/tanks-core');
const { LobbySession } = await import('@lan-party/lobby');

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

/*
 * Every check sets the exit code. This used to keep "findings" about the
 * unmerged b/lobby branch apart from failures, so a known bug in someone
 * else's code would not turn anything red. The session is platform code now,
 * so a lobby that seats two players on one team is simply a failure.
 *
 * (The WebSocket carriage here is the `ws` package, not `LanHost` -- real
 * browsers against `LanHost` are `games/tanks/lanhost-smoke.mjs`.)
 */
const failures = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : ` -- ${detail}`}`);
  if (!ok) failures.push(detail ? `${what} (${detail})` : what);
};
check.finding = check;

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
// public `state` property.
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
check.finding(new Set(teams).size === teams.length,
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
check.finding(new Set(afterTeams).size === afterTeams.length,
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

// The match is built from the roster above, so a seating bug is not a wrong
// label -- it reaches the world every player is driving in. Checked there too.
if (entered) {
  const world = await live[0].p.evaluate(() => ({
    tanks: window.__state.world.tanks.length,
    teams: window.__state.world.tanks.map((t) => t.team),
  }));
  console.log(`\nthe match everyone is now in: ${world.tanks} tanks on teams ${JSON.stringify(world.teams)}`);
  check.finding(new Set(world.teams).size === world.tanks,
    'and every tank in the running match is on its own team',
    `${new Set(world.teams).size} teams for ${world.tanks} tanks -- two players who cannot hurt each other`);
}

await browser.close();
httpServer.close();
wss.close();

if (failures.length) {
  console.log(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nthe lobby session seated real browsers and carried them into a match');
process.exit(0);
