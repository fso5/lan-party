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

import {
  LanHost,
  LobbyOp,
  MsgType,
  Reader,
  Writer,
  writeLobbyWelcome,
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
    return '127.0.0.1';
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
    this.#server.listen(port, '127.0.0.1');
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

const lan = new LanHost(new NodeTcp(), { page: new Uint8Array(page), port: 0 });
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

const browser = await chromium.launch({ executablePath: findChrome() });
const errors = [];
const pages = [];
for (let i = 0; i < 2; i++) {
  const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
  p.on('pageerror', (e) => errors.push(`p${i}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(`p${i}: ${m.text()}`);
  });
  await p.goto(`http://127.0.0.1:${port}/`);
  pages.push(p);
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

check(first.rows.length === 3, `expected 3 rows (host + 2 browsers), got ${first.rows.length}`);
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

// Tap a team and confirm the change round-trips through the host rather than
// being applied locally.
await pages[0].click('#lobby-team-buttons button:last-child');
await pages[0].waitForTimeout(600);
const afterTeam = await read(pages[0]);
const chosen = afterTeam.teams.findIndex((t) => t.on);
check(chosen === afterTeam.teams.length - 1, `team change did not round-trip (selected ${chosen})`);

// Ready likewise.
await pages[0].click('#btn-ready');
await pages[0].waitForTimeout(600);
const afterReady = await read(pages[0]);
check(afterReady.ready === 'Ready', `ready did not round-trip (button says "${afterReady.ready}")`);

// And the other browser must see both changes, since the roster is broadcast.
const other = await read(pages[1]);
check(
  other.rows.some((r) => (r.tag ?? '').includes('ready') && !r.you),
  'the other player must see the first one become ready',
);

await browser.close();
await lan.stop();

for (const e of errors) failures.push('console error: ' + e);
if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('lobby smoke passed: roster rendered, team and ready round-tripped through the host');
