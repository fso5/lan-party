/**
 * End-to-end test of the lobby, browser side.
 *
 * The lobby panel only appears when a host sends a roster, and no other test in
 * the repo has a host that does. So without this the whole lobby path -- Join,
 * Welcome, Roster, team selection, ready, hide-on-start -- ships completely
 * unexercised, which is where every bug in this project has been so far.
 *
 * Runs a real `LanHost` speaking the real lobby protocol, drives two real
 * browsers against it, and asserts what a player would actually see.
 *
 * Exits non-zero on failure.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lanAddress } from './lan-address.mjs';

import {
  LanHost,
  LobbyOp,
  MatchHost,
  MsgType,
  Reader,
  VERSUS_MAPS,
  Writer,
  createWorld,
  loadArena,
  writeLobbyWelcome,
  writeMatchStart,
  writeRoster,
} from '@tanks/core';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, 'dist', 'tanks-proto.html'));

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

/** node:net-backed TcpServer, the same shape the Kotlin module implements. */
const { createServer } = await import('node:net');
const { once } = await import('node:events');

class NodeTcp {
  #server = null;
  #socks = new Map();
  #handlers = null;
  #next = 1;
  setHandlers(h) {
    this.#handlers = h;
  }
  getIpAddress() {
    return HOST;
  }
  async start(port) {
    this.#server = createServer((sock) => {
      const id = `c${this.#next++}`;
      this.#socks.set(id, sock);
      this.#handlers.onConnection(id);
      sock.on('data', (b) =>
        this.#handlers.onData(id, new Uint8Array(b.buffer, b.byteOffset, b.byteLength)),
      );
      sock.on('close', () => {
        this.#socks.delete(id);
        this.#handlers.onClose(id);
      });
      sock.on('error', () => sock.destroy());
    });
    // All interfaces, so a browser can reach this the way a phone would.
    this.#server.listen(port, '0.0.0.0');
    await once(this.#server, 'listening');
    return this.#server.address().port;
  }
  async stop() {
    for (const s of this.#socks.values()) s.destroy();
    this.#server?.close();
  }
  send(id, data) {
    this.#socks.get(id)?.write(Buffer.from(data));
  }
  close(id) {
    this.#socks.get(id)?.end();
  }
}

// A real interface address rather than loopback: browsers treat localhost as a
// secure context and a phone's 192.168.x.x is not, so testing on loopback is
// easier than reality. See lan-address.mjs.
const HOST = lanAddress();

const tcp = new NodeTcp();
const lan = new LanHost(tcp, { page: new Uint8Array(page), port: 0 });
const port = await lan.start();

// A minimal host-side lobby: seat whoever sends Join, honour team changes,
// broadcast the roster. This mirrors LobbySession without depending on the
// app package, which is a different workspace and a different session's lane.
const roster = { mapId: 0, mode: 0, roundsToWin: 3, slots: [] };
const peerBySlot = new Map();
let nextSlotId = 0;

// Seat 0 is the host itself: it plays, it is not a dedicated server.
roster.slots.push({ slotId: nextSlotId++, name: 'Host', team: 0, ready: true, isHost: true });

function freeTeam() {
  // Lowest unused, not the count -- the count collides after anyone leaves.
  const taken = new Set(roster.slots.map((s) => s.team));
  let t = 0;
  while (taken.has(t)) t++;
  return t;
}

function broadcastRoster() {
  const w = new Writer();
  writeRoster(w, roster);
  lan.transport.broadcast(w.finish(), true);
}

lan.onPlayerLeave = (peerId) => {
  const entry = [...peerBySlot.entries()].find(([, id]) => id === peerId);
  if (!entry) return;
  peerBySlot.delete(entry[0]);
  roster.slots = roster.slots.filter((s) => s.slotId !== entry[0]);
  broadcastRoster();
};

lan.transport.setEvents({
  onPacket: (from, data) => {
    if (data.length < 2 || data[0] !== MsgType.Lobby) return;
    const r = new Reader(data);
    r.u8();
    const op = r.u8();

    if (op === LobbyOp.Join) {
      const name = r.str();
      const slot = { slotId: nextSlotId++, name: name || 'Player', team: freeTeam(), ready: false, isHost: false };
      roster.slots.push(slot);
      peerBySlot.set(slot.slotId, from);
      const w = new Writer();
      writeLobbyWelcome(w, slot.slotId);
      lan.transport.send(from, w.finish(), true);
      broadcastRoster();
      return;
    }

    const entry = [...peerBySlot.entries()].find(([, id]) => id === from);
    if (!entry) return;
    const slot = roster.slots.find((s) => s.slotId === entry[0]);
    if (!slot) return;
    if (op === LobbyOp.SetTeam) slot.team = r.u8();
    else if (op === LobbyOp.SetReady) slot.ready = r.u8() !== 0;
    else return;
    broadcastRoster();
  },
});

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

// The browser must not use this environment's HTTP proxy. It intercepts
// non-loopback addresses and answers the WebSocket upgrade with a 403, which
// has nothing to do with the game -- a phone talking to a phone has no proxy
// in the path. Loopback was bypassed automatically, which is part of why
// testing on localhost hid this whole class of difference.
const browser = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-proxy-server'],
});
const errors = [];
/**
 * Set once the host is deliberately stopped.
 *
 * A browser logs a console error for every failed WebSocket attempt, so the
 * teardown check would otherwise fail the run with the very noise it is trying
 * to provoke.
 */
let expectingDisconnect = false;
/*
 * One phone, one desktop -- and the phone is the one that picks a team.
 *
 * Everyone joining a hosted match does it on a phone, in a browser, held
 * sideways. Both clients here used to be 800x600 with a mouse, so the lobby --
 * the only screen where a player chooses a side -- had never been seen at the
 * size or with the input every real player uses.
 *
 * That mattered: the game page shipped with a full-screen overlay covering the
 * arena and both thumb buttons buried under the canvas, none of which a
 * mouse-driven desktop viewport could notice.
 *
 * Separate contexts rather than pages, because `hasTouch` is a context option
 * -- and because pages in one context share localStorage, so the two players'
 * names were racing to write the same key.
 */
const PHONE = { viewport: { width: 844, height: 390 }, hasTouch: true };
const DESKTOP = { viewport: { width: 800, height: 600 } };
/*
 * Three browsers and the host, which is four players -- the size the versus
 * maps are built for, and the smallest group that can be two-on-two.
 *
 * Two clients was never the target. The ask was "teams or free-for-all, not
 * just one team but multiple", and with one client per side there is no
 * difference between a team and a player: a roster that seats everybody
 * one-per-team looks identical to one that honours a choice. Four players on
 * two teams is the smallest arrangement where getting it wrong is visible.
 *
 * It also puts more than one client on the wire at once, which nothing did:
 * concurrent handshakes, a roster broadcast to three sockets, and three
 * snapshot streams off one phone.
 */
const NAMES = ['Alpha', 'Bravo', 'Carol'];
const pages = [];
for (let i = 0; i < NAMES.length; i++) {
  const ctx = await browser.newContext(i === 0 ? PHONE : DESKTOP);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`p${i}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !expectingDisconnect) errors.push(`p${i}: ${m.text()}`);
  });
  // A stable name per browser. The default is random, which is fine for people
  // and useless for asserting which row belongs to whom.
  const name = NAMES[i];
  await p.addInitScript((n) => localStorage.setItem('tanks.name', n), name);
  await p.goto(`http://${HOST}:${port}/`);
  pages.push(p);
}

// Pin the point of using a LAN address: a phone's origin is *not* a secure
// context, and localhost is. If this ever reverts to loopback, this fails and
// says why rather than the tests quietly getting easier.
{
  // Fails rather than skips if someone points this back at loopback while a
  // real interface exists -- a skip would let the tests quietly get easier,
  // which is the exact failure this guards against.
  check(
    HOST === lanAddress(),
    `must reach the host the way a phone does; using ${HOST} with ${lanAddress()} available`,
  );
  const secure = await pages[0].evaluate(() => window.isSecureContext);
  if (HOST === '127.0.0.1') {
    console.log('no non-loopback interface here; running on loopback, which is a secure context unlike a phone');
  } else {
    check(secure === false, `expected an insecure origin like a phone's, got isSecureContext=${secure}`);
    console.log(`origin ${HOST}: isSecureContext=${secure} (a phone sees the same)`);
  }
}

// The panel is the whole point: it must appear off the back of a real roster.
for (const [i, p] of pages.entries()) {
  try {
    await p.waitForSelector('#match-lobby:not([hidden])', { timeout: 15_000 });
  } catch {
    failures.push(`p${i}: the lobby never appeared`);
  }
}

const read = (p) =>
  p.evaluate(() => ({
    rows: [...document.querySelectorAll('#lobby-slots li')].map((li) => ({
      who: li.querySelector('.who')?.textContent,
      tag: li.querySelector('.tag')?.textContent,
      you: li.dataset.you === 'true',
    })),
    teams: [...document.querySelectorAll('#lobby-team-buttons button')].map((b) => ({
      label: b.textContent,
      on: b.getAttribute('aria-pressed') === 'true',
    })),
    ready: document.getElementById('btn-ready')?.textContent,
  }));

const first = await read(pages[0]);
console.log('p0 lobby:', JSON.stringify(first));

// The other half of the late-joiner hint below: somebody who arrives while the
// lobby is open is answered in milliseconds and must never see it. A hint that
// fires for everyone is worse than no hint, because it stops meaning anything.
{
  const hint = await pages[0].evaluate(() => {
    const el = document.getElementById('net-hint');
    return el.hidden ? null : el.textContent;
  });
  check(
    !hint || !/waiting for the host/i.test(hint),
    `a normally-seated player should not be told they are waiting (saw ${JSON.stringify(hint)})`,
  );
}

check(
  first.rows.length === NAMES.length + 1,
  `expected ${NAMES.length + 1} rows (host + ${NAMES.length} browsers), got ${first.rows.length}`,
);
check(first.rows.filter((r) => r.you).length === 1, 'exactly one row must be marked as yours');
check(first.rows.some((r) => (r.tag ?? '').includes('host')), 'the host must be labelled');
check(first.teams.length >= 2, `expected >= 2 team buttons, got ${first.teams.length}`);
check(
  first.teams.filter((t) => t.on).length === 1,
  'exactly one team button must show as selected',
);

// Nobody may share a team: that is the whole reason free-for-all is the default.
const teamsHeld = roster.slots.map((s) => s.team);
check(new Set(teamsHeld).size === teamsHeld.length, `teams collided on the host: ${teamsHeld}`);

/* --- a dropped connection must heal itself -------------------------------
 *
 * Sockets do not survive an evening on a phone: the screen sleeps, the tab is
 * suspended, someone walks out of range. Until now a drop was permanent -- the
 * page went "offline" and the only way back was knowing to reload, which on a
 * home-screen install is not even an obvious gesture.
 *
 * Done before the team tap so the roster ends up in the same shape either way:
 * Bravo's slot is freed and its rejoin takes the same lowest-unused team.
 */
async function waitFor(what, predicate, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  failures.push(`timed out waiting for ${what}`);
  return false;
}

{
  const bravo = roster.slots.find((s) => s.name === 'Bravo');
  const bravoPeer = bravo && peerBySlot.get(bravo.slotId);
  check(!!bravoPeer, 'Bravo should be seated before being dropped');
  if (bravoPeer) {
    tcp.close(bravoPeer);
    await waitFor('Bravo to drop out of the roster', () => roster.slots.length === NAMES.length);
    await waitFor('Bravo to reconnect on its own', () => roster.slots.length === NAMES.length + 1);
    check(
      roster.slots.some((s) => s.name === 'Bravo'),
      'Bravo must come back by itself rather than needing a reload',
    );
    console.log('after drop + reconnect:', JSON.stringify(roster.slots.map((s) => `${s.name}=t${s.team}`)));
    // Let the roster broadcast settle on both pages before the team tap.
    await pages[0].waitForTimeout(400);
  }
}

/*
 * Before tapping anything: is the lobby usable with a thumb on a phone?
 *
 * `click()` synthesises a press on whatever the selector matched, so it works
 * even when the control is buried under something else, off screen, or two
 * pixels tall. A player's thumb hits whatever is topmost at that pixel. Ask
 * what is actually there, and how big it is.
 */
{
  const reach = await pages[0].evaluate(() => {
    /*
     * Measure the region a thumb can actually land on, not the box.
     *
     * A control can be visually small and still comfortable to hit if its
     * touch area is extended past its border -- so walking outward from the
     * centre asking "does this pixel still reach the button?" measures what a
     * player experiences, where `getBoundingClientRect()` measures what the
     * designer drew. It also stops the check from forcing chunky buttons into
     * a layout where vertical space is genuinely contested.
     */
    const probe = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const reaches = (x, y) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit) || hit.parentElement === el);
      };
      const walk = (dx, dy) => {
        let n = 0;
        while (n < 40 && reaches(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
        return n;
      };
      const hit = document.elementFromPoint(cx, cy);
      const tapW = walk(-1, 0) + walk(1, 0) + 1;
      const tapH = walk(0, -1) + walk(0, 1) + 1;
      return {
        sel,
        onTop: reaches(cx, cy),
        hit: hit ? `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''}` : 'nothing',
        inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
        // 28px: below every published minimum (WCAG 2.5.8 wants 24, Apple 44,
        // Material 48), so this only fires on a control that is genuinely hard
        // to hit rather than merely tighter than a guideline prefers.
        big: Math.min(tapW, tapH) >= 28,
        size: `${Math.round(r.width)}x${Math.round(r.height)} drawn, ${tapW}x${tapH} tappable`,
      };
    };
    return ['#lobby-team-buttons button:last-child', '#btn-ready'].map(probe);
  });
  for (const r of reach) {
    check(!r.missing, `${r.sel} is missing from the lobby`);
    if (r.missing) continue;
    check(r.onTop, `${r.sel} is not the topmost thing at its own centre (${r.hit} is)`);
    check(r.inView, `${r.sel} is off screen on a phone -- a thumb cannot reach it`);
    check(r.big, `${r.sel} is ${r.size} on a phone, too small to hit reliably`);
  }
  console.log('phone lobby reachability:', JSON.stringify(reach));
}

// The panel itself must fit the phone sideways. It is `max-height: 86vh` with
// its own scroll, so a roster that overflows is survivable -- a panel wider
// than the screen is not.
{
  const wide = await pages[0].evaluate(() => {
    const r = document.querySelector('#match-lobby .panel').getBoundingClientRect();
    return { over: Math.round(r.width - innerWidth), w: Math.round(r.width), vw: innerWidth };
  });
  check(wide.over <= 0, `the lobby panel is ${wide.w}px wide on a ${wide.vw}px screen`);
}

/*
 * Form two actual teams, and confirm every choice round-trips through the host
 * rather than being applied locally.
 *
 * Host is seat 0 on team 0. Alpha joins it; Bravo and Carol take team 1. That
 * is two on two -- the arrangement a default free-for-all seating cannot
 * produce by accident, which is what makes the check downstream meaningful.
 *
 * The buttons are rendered in team order, so index is team id.
 */
const WANTED_TEAM = { Alpha: 0, Bravo: 1, Carol: 1 };

/**
 * Press a control the way that browser can.
 *
 * Only the first context has `hasTouch`; the others are desktop on purpose, so
 * the lobby is exercised under both kinds of input rather than only the one
 * that happens to be easiest to drive. `page.tap` throws outright without the
 * context option, which is a better failure than silently clicking.
 */
const press = (i, sel) => (i === 0 ? pages[i].tap(sel) : pages[i].click(sel));

for (const [i] of pages.entries()) {
  const team = WANTED_TEAM[NAMES[i]];
  await press(i, `#lobby-team-buttons button:nth-child(${team + 1})`);
  await pages[i].waitForTimeout(400);
}
await pages[0].waitForTimeout(400);

for (const [i, p] of pages.entries()) {
  const name = NAMES[i];
  const after = await read(p);
  const chosen = after.teams.findIndex((t) => t.on);
  check(
    chosen === WANTED_TEAM[name],
    `${name} tapped team ${WANTED_TEAM[name]} but the roster came back with ${chosen}`,
  );
}

// Two on two, from the host's own view of the roster.
{
  const byTeam = new Map();
  for (const slot of roster.slots) byTeam.set(slot.team, (byTeam.get(slot.team) ?? 0) + 1);
  check(byTeam.size === 2, `expected two teams, host sees ${byTeam.size}: ${JSON.stringify([...byTeam])}`);
  check(
    [...byTeam.values()].every((n) => n === 2),
    `expected two on two, host sees ${JSON.stringify([...byTeam])}`,
  );
  console.log('teams formed:', JSON.stringify(roster.slots.map((s) => `${s.name}=t${s.team}`)));
}

// Ready likewise.
await press(0, '#btn-ready');
await pages[0].waitForTimeout(600);
const afterReady = await read(pages[0]);
check(afterReady.ready === 'Ready', `ready did not round-trip (button says "${afterReady.ready}")`);

// And every other browser must see it, since the roster is broadcast to all of
// them. With three clients this is the first time a broadcast has had to reach
// more than one socket.
for (const [i, p] of pages.entries()) {
  if (i === 0) continue;
  const other = await read(p);
  check(
    other.rows.some((r) => (r.tag ?? '').includes('ready') && !r.you),
    `${NAMES[i]} must see Alpha become ready`,
  );
}

/* --- the handoff out of the lobby ----------------------------------------
 *
 * The point of the whole feature: a team picked in the lobby has to be the team
 * you are actually on once the match starts. Nothing else tests that. The
 * lobby could round-trip perfectly and the match still seat everyone
 * one-per-team, and every existing check would pass.
 *
 * After the tap above the roster is Host=t0, Alpha=t2, Bravo=t2 -- a genuine
 * two-on-one rather than the default one-team-each.
 */
const map = VERSUS_MAPS[roster.mapId] ?? VERSUS_MAPS[0];
const arena = loadArena(map);
// Roster order is the wire contract: tank ids come from creation order, so
// players must be built in exactly this order on every device.
const players = roster.slots.map((slot, i) => ({ team: slot.team, spawnIndex: i }));
const seed = 0xa11ce;
const world = createWorld({ arena, seed, players, bots: [] });

// Constructing this replaces the lobby's onPacket, which is correct now that
// the lobby is done -- same key, last writer wins.
const match = new MatchHost(world, lan.transport);
match.localTankId = world.tanks[0].id;

const expectedTeam = new Map(); // page index -> team chosen in the lobby
roster.slots.forEach((slot, i) => {
  const peer = peerBySlot.get(slot.slotId);
  if (!peer) return; // slot 0 is the host itself
  match.addClient(peer, i);
  expectedTeam.set(slot.name, { tankId: i, team: slot.team });
  const w = new Writer();
  writeMatchStart(w, {
    mapId: map.id,
    seed,
    hostTick: world.tick,
    yourTankId: i,
    players,
    bots: [],
  });
  lan.transport.send(peer, w.finish(), true);
});
console.log('starting match with roster:', JSON.stringify(roster.slots.map((s) => `${s.name}=t${s.team}`)));

// Drive the host so snapshots actually flow while the clients settle.
let ticking = setInterval(() => match.update(1000 / 60), 16);

for (const [i, p] of pages.entries()) {
  const name = NAMES[i];
  const want = expectedTeam.get(name);
  try {
    await p.waitForFunction(
      (id) => {
        const w = window.__state?.world;
        return !!w && w.tanks.some((t) => t.id === id) && document.getElementById('match-lobby').hidden;
      },
      want.tankId,
      { timeout: 15_000 },
    );
  } catch {
    failures.push(`${name}: never entered the match after MatchStart`);
    continue;
  }

  const seenTeam = await p.evaluate(
    (id) => window.__state.world.tanks.find((t) => t.id === id)?.team,
    want.tankId,
  );
  console.log(`${name}: tank ${want.tankId} team ${seenTeam} (chose ${want.team})`);
  check(
    seenTeam === want.team,
    `${name} chose team ${want.team} in the lobby but is on team ${seenTeam} in the match`,
  );
}

/* --- round two, over a real socket ---------------------------------------
 *
 * The round-restart path is where the worst bug of the night lived: nothing
 * rebuilt the world between rounds, so one win swept a whole best-of-three in
 * about six seconds with nobody playing. That is fixed and covered by core
 * tests over a loopback transport -- but a round *transition* has never been
 * driven over a real socket with real browsers, and the client half of it
 * (rebuild the world from a fresh MatchStart, mid-match) is the part those
 * tests cannot reach.
 */
{
  /*
   * The side that does not contain the host.
   *
   * This used to read "both clients share a team, so either one names the
   * winning side", which stopped being true the moment the roster became a
   * real two-on-two: Alpha is on the host's team now. Deriving the side from
   * the host's own team is what keeps this correct whatever the lobby chose --
   * and it is the only side that can win a round by the host dying.
   */
  const hostTeamId = world.tanks[0].team;
  const clientTeamId = [...expectedTeam.values()].map((v) => v.team).find((t) => t !== hostTeamId);
  const roundSeed = (round) => seed + round * 7919;
  match.roundBuilder = (round) =>
    createWorld({ arena, seed: roundSeed(round), players, bots: [] });

  match.onRoundStart = (nextWorld, round) => {
    // Same roster, so tank ids are unchanged and everyone keeps their seat.
    roster.slots.forEach((slot, i) => {
      const peer = peerBySlot.get(slot.slotId);
      if (!peer) return;
      const w = new Writer();
      writeMatchStart(w, {
        mapId: map.id,
        seed: roundSeed(round),
        hostTick: nextWorld.tick,
        yourTankId: i,
        players,
        bots: [],
      });
      lan.transport.send(peer, w.finish(), true);
    });
  };

  /*
   * Mark each client's arena before the round ends.
   *
   * Checking that the tanks are alive again is *not* enough, and I only found
   * that by mutating the host to skip the round-two MatchStart and watching the
   * test still pass. Snapshots carry alive flags, so an un-rebuilt client gets
   * its tanks revived anyway -- while keeping round one's arena and shell state.
   * The tanks look right and the walls disagree, which is the worst kind of
   * desync because nothing on screen says anything is wrong.
   *
   * A rebuilt world comes from loadArena, so it erases this. A
   * snapshot-patched one does not.
   */
  const scribbles = await Promise.all(
    pages.map((p) =>
      p.evaluate(() => {
        const a = window.__state.world.arena;
        const i = Math.floor(a.tiles.length / 2);
        const before = a.tiles[i];
        a.tiles[i] = before === 0 ? 2 : 0;
        return { i, before };
      }),
    ),
  );

  // Kill everyone on the host's side, so the other team takes the round. With
  // two on two that is the host and Alpha, not the host alone.
  for (const t of match.world.tanks) if (t.team === hostTeamId) t.alive = false;

  const reachedRoundTwo = await waitFor(
    'the host to start round two',
    () => match.match.round === 2 && match.world.tanks.every((t) => t.alive),
    20_000,
  );
  check(reachedRoundTwo, 'the host must begin a second round on a fresh world');

  if (reachedRoundTwo) {
    check(match.match.score.get(clientTeamId) === 1, 'the winning team should have one round');

    // The clients have to follow. A client that misses the new MatchStart sits
    // watching a finished round while the match carries on without it.
    for (const [i, p] of pages.entries()) {
      const name = NAMES[i];
      const want = expectedTeam.get(name);
      const followed = await p
        .waitForFunction(
          (id) => {
            const w = window.__state?.world;
            const me = w?.tanks.find((t) => t.id === id);
            return !!me && me.alive && w.tanks.every((t) => t.alive);
          },
          want.tankId,
          { timeout: 15_000 },
        )
        .then(() => true)
        .catch(() => false);
      check(followed, `${name} did not follow the host into round two`);

      if (followed) {
        const team = await p.evaluate(
          (id) => window.__state.world.tanks.find((t) => t.id === id)?.team,
          want.tankId,
        );
        check(
          team === want.team,
          `${name} was on team ${want.team} in round one and ${team} in round two`,
        );

        const rebuilt = await p.evaluate(
          ({ i, before }) => window.__state.world.arena.tiles[i] === before,
          scribbles[i],
        );
        check(
          rebuilt,
          `${name} kept round one's arena -- the world was never rebuilt, only patched by snapshots`,
        );
      }
    }
    console.log(`round two: host round=${match.match.round}, both clients followed with their teams intact`);
  }
}

/*
 * And the match itself is genuinely two on two.
 *
 * Asserted on the built world rather than on the roster, because the roster is
 * only an intention until `createWorld` turns it into tanks. Four players each
 * on their own team would satisfy every check above about choices
 * round-tripping and still be a free-for-all wearing team labels -- which is
 * exactly the state the app ships in today, and the thing this whole path
 * exists to make impossible.
 */
{
  const sizes = new Map();
  for (const t of world.tanks) sizes.set(t.team, (sizes.get(t.team) ?? 0) + 1);
  const shape = JSON.stringify([...sizes].sort());
  check(sizes.size === 2, `the match should have two sides, has ${sizes.size}: ${shape}`);
  check([...sizes.values()].every((n) => n === 2), `the match should be two on two: ${shape}`);
  // Somebody must actually be sharing with the host, or "teams" is untested no
  // matter how the numbers add up.
  check(
    world.tanks.filter((t) => t.team === world.tanks[0].team).length === 2,
    'a client must be on the host\u2019s own side',
  );
  console.log('match shape:', shape, '(team -> tanks)');
}

/* --- the host's phone going to sleep ------------------------------------- */
{
  /*
   * The single most likely thing to happen at a kitchen table: the host puts
   * their phone down and the screen locks.
   *
   * Nothing disconnects. The host's socket threads hold every connection open
   * while the loop that steps the match stops, so snapshots cease. Each client
   * keeps predicting its own tank perfectly and every other tank stands still
   * -- which looks exactly like everyone else quitting at once, and
   * "reconnecting" never appears because nothing dropped.
   *
   * Stopping the interval is precisely that: the transport stays up, the host
   * simply stops stepping.
   */
  clearInterval(ticking);

  const told = await pages[0]
    .waitForFunction(
      () => {
        const el = document.getElementById('net-hint');
        return el && !el.hidden && /gone to sleep/i.test(el.textContent ?? '');
      },
      undefined,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(told, 'a frozen match must say the host went quiet, not just stop');
  if (told) {
    const text = await pages[0].evaluate(() => document.getElementById('net-hint').textContent);
    console.log('hint shown while the host is asleep:', JSON.stringify(text));
  }

  // And it clears the moment the host is back, or it becomes furniture.
  ticking = setInterval(() => match.update(1000 / 60), 16);
  const cleared = await pages[0]
    .waitForFunction(
      () => {
        const el = document.getElementById('net-hint');
        return !el || el.hidden || !/gone to sleep/i.test(el.textContent ?? '');
      },
      undefined,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(cleared, 'the hint must go away when the host wakes up');
}

/* --- somebody arriving after the match started --------------------------- */
{
  /*
   * The ordinary way to turn up late at a kitchen table: open the URL once
   * everyone else is already playing.
   *
   * It lands in a gap. The socket connects and the Join is sent, but the
   * host's lobby handler has been replaced by `MatchHost` for the duration of
   * the match, so nothing answers until the next round is built. With the
   * socket perfectly healthy no reconnect hint fires either -- so the page
   * showed a normal single-player game, which is the worst available answer
   * because it looks like it is working.
   */
  const ctx = await browser.newContext(PHONE);
  const late = await ctx.newPage();
  late.on('pageerror', (e) => errors.push(`late: ${e.message}`));
  late.on('console', (m) => {
    if (m.type() === 'error' && !expectingDisconnect) errors.push(`late: ${m.text()}`);
  });
  await late.addInitScript(() => localStorage.setItem('tanks.name', 'Latecomer'));
  await late.goto(`http://${HOST}:${port}/`);

  // The socket must actually be up -- this is not the stranded case, and if it
  // were, the wrong hint would pass this test for the wrong reason.
  const connected = await late
    .waitForFunction(() => window.__state && document.getElementById('net-status')?.textContent !== 'offline', undefined, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check(connected, 'a late joiner should reach the host at all');

  const told = await late
    .waitForFunction(
      () => {
        const el = document.getElementById('net-hint');
        return el && !el.hidden && /waiting for the host/i.test(el.textContent ?? '');
      },
      undefined,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(told, 'a late joiner must be told they are waiting, not shown a silent solo game');
  if (told) {
    const text = await late.evaluate(() => document.getElementById('net-hint').textContent);
    console.log('hint shown to a late joiner:', JSON.stringify(text));
  }
  await ctx.close();
}

/* --- a host that goes away must say something useful --------------------- */
{
  // "reconnecting" forever tells a player nothing they can act on. The two
  // real causes -- wrong network, or the host closed the game -- are both
  // fixable in seconds if somebody says so.
  expectingDisconnect = true;
  await lan.stop();
  const explained = await pages[0]
    .waitForFunction(
      () => {
        const el = document.getElementById('net-hint');
        return el && !el.hidden && /host/i.test(el.textContent ?? '');
      },
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(explained, 'a client cut off from the host must explain what to do, not just say "reconnecting"');
  if (explained) {
    const text = await pages[0].evaluate(() => document.getElementById('net-hint').textContent);
    console.log('hint shown to a stranded client:', JSON.stringify(text));
  }
}

clearInterval(ticking);

await browser.close();

for (const e of errors) failures.push('console error: ' + e);
if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('lobby smoke passed: roster rendered, team and ready round-tripped, and the chosen teams survived into the match');
