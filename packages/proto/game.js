/**
 * Browser prototype front-end.
 *
 * This is a throwaway harness, not the shipping app. It exists to answer the
 * one question the test suite cannot: do the ricochets feel right? Everything
 * here talks to @tanks/core through the same interface the React Native app
 * will, so anything we learn about tuning transfers directly.
 *
 * Bundled into a single self-contained HTML file by build.mjs -- the core
 * bundle is spliced in above this code, so its exports are in scope as plain
 * module-level bindings.
 */

/* global createWorld, step, loadArena, MISSIONS, VERSUS_MAPS, emptyInput,
   isMatchOver, stepShell, dcos, dsin, datan2, TANK_RADIUS, TANK_SPECS,
   TICK_HZ, EventKind, Tile, TankKind, livingTeams, DRAW, MsgType, LobbyOp,
   DEFAULT_MATCH_SIZE,
   readRoster, writeLobbyJoin, writeLobbySetTeam, writeLobbySetReady, Writer */

const ALL_MAPS = [...MISSIONS, ...VERSUS_MAPS];

/*
 * One colour per seat the lobby can hand out, and the count is the point.
 *
 * There were four, for the four spawns the maps used to have. Seats 5-8 then
 * arrived and `TEAM_COLORS[t.team]` -- the tank renderer, the one lookup here
 * without a modulo -- returned undefined for them. Measured in a browser
 * rather than assumed: assigning undefined to `fillStyle` is silently ignored,
 * so the canvas keeps whatever colour it had. A team-4 tank drew in team 0's
 * blue and a team-5 tank in team 1's red, changing with draw order. Not a
 * duplicate colour, which would at least be stable -- a tank wearing the
 * colour of whoever happened to be painted before it.
 *
 * The four additions stay in the same register as the originals (saturation
 * 0.39-0.56, lightness 0.40-0.54) so a late seat reads as another tank rather
 * than as a different kind of object. Closest pair is dE76 31.3, against 39.0
 * for the original four; `teamColour` in the smoke asserts a floor of 25 so a
 * later edit cannot quietly collide two seats.
 *
 * Untouched and worth knowing: team green sits 14.6 from the green *bot*,
 * which is the closest thing on the field to a genuine ambiguity here. It
 * predates all of this and changing it would repaint an existing team.
 */
const TEAM_COLORS = [
  '#2E6DA4', // blue
  '#B33A3A', // red
  '#3E8E5A', // green
  '#8A5CB8', // violet
  '#C97A2E', // orange
  '#2FA3B8', // cyan
  '#B84A86', // magenta
  '#7C8C2E', // olive
];

/**
 * Colour for a seat, for every caller.
 *
 * A function rather than four call sites indexing the array, because three of
 * them remembered the modulo and the fourth did not -- and the fourth was the
 * renderer.
 */
const teamColor = (team) => TEAM_COLORS[((team % TEAM_COLORS.length) + TEAM_COLORS.length) % TEAM_COLORS.length];
const KIND_COLORS = {
  0: '#2E6DA4', // player  - blue
  1: '#8A6A45', // brown
  2: '#7A7D82', // grey
  3: '#2F8C8C', // teal
  4: '#C9A227', // yellow
  5: '#4F8A3D', // green
  6: '#33302C', // black
};

const state = {
  world: null,
  mapIndex: 0,
  /**
   * Humans sharing this screen. Two phones with no laptop and no internet have
   * nothing to run a host on, so couch play on a single device is the only
   * offline multiplayer available to the web build.
   */
  localPlayers: 1,
  running: true,
  showTrajectory: false,
  showDebug: false,
  outcome: null,
  outcomeTimer: 0,
  particles: [],
  shake: 0,
  tickTimes: [],
};

const input = {
  keys: new Set(),
  pointer: { x: 0, y: 0, active: false, down: false },
  // Touch sticks: { id, ox, oy, x, y } while dragging.
  driveStick: null,
  aimStick: null,
  aimHold: { x: 1, y: 0 },
  fireLatch: false,
  mineLatch: false,
  // Per-seat state for couch play: seat 0 owns the left half, seat 1 the right.
  seatHold: [{ x: 1, y: 0 }, { x: -1, y: 0 }],
  seatFire: [false, false],
};

const canvas = document.getElementById('arena');
const ctx = canvas.getContext('2d');

/**
 * Multiplayer.
 *
 * When the page is served by server.mjs there is a WebSocket endpoint on the
 * same origin. We try it; if nothing answers we stay in single-player. Above
 * the transport this is the same MatchClient that will run over Bluetooth --
 * the point of testing this way is that only the transport differs.
 */
const net = {
  socket: null,
  transport: null,
  client: null,
  dispatch: null,
  status: 'offline',
  /**
   * Round and score state, kept here rather than read off MatchClient.
   *
   * The host sends MatchStart at the start of every round, so a fresh
   * MatchClient is built each time and its `lastRound` goes back to null.
   * Reading the scoreboard from it would blank the score the instant a new
   * round began -- exactly when people look at it.
   */
  round: 1,
  scores: [],
  matchOver: false,
  banner: null,
  /**
   * Lobby state, or null when the host never sends a roster.
   *
   * Null is the normal case for a host that starts a match immediately, so the
   * lobby is strictly additive: the panel only appears once a roster actually
   * arrives, and every existing flow is untouched.
   */
  roster: null,
  mySlotId: -1,
  ready: false,
};

/**
 * A name for this phone, kept between visits.
 *
 * The alternative is asking for one before anybody can play, which is a form to
 * fill in while four people wait. A recognisable default that can be changed
 * later beats a mandatory prompt.
 */
function localPlayerName() {
  try {
    const saved = localStorage.getItem('tanks.name');
    if (saved) return saved;
    const name = `Player ${1 + Math.floor(Math.random() * 99)}`;
    localStorage.setItem('tanks.name', name);
    return name;
  } catch {
    // Private browsing can refuse storage; a name is not worth failing over.
    return 'Player';
  }
}

/** Bluetooth match state. Only meaningful inside the native app. */
const ble = {
  adapter: null,
  transport: null,
  host: null,
  hosts: new Map(),
  role: null,
};

function setNetStatus(s) {
  net.status = s;
  const el = document.getElementById('net-status');
  el.textContent = s;
  el.dataset.state = s;
}

/**
 * A line of plain English for the states where the status alone strands you.
 *
 * "reconnecting" forever tells a player nothing they can act on, and the two
 * things that actually cause it -- being on the wrong network, or the host
 * having closed the game -- are both things they can fix in ten seconds if
 * somebody says so.
 */
function setNetHint(text) {
  const el = document.getElementById('net-hint');
  el.textContent = text ?? '';
  el.hidden = !text;
}

/** Pending "the host has not answered" timer, if any. */
let waitingForHost = null;

/**
 * Say something when the host stops talking but the socket stays up.
 *
 * The host phone's screen locking does not disconnect anything -- its TCP
 * threads hold the socket open while the loop that steps the match stops. So
 * snapshots cease, your own tank keeps responding perfectly, and every other
 * tank stands still. It looks exactly like everyone else quitting at the same
 * moment, and "reconnecting" never appears because nothing dropped.
 *
 * Three seconds, against snapshots that arrive fifteen times a second. That is
 * far past any jitter and still short enough to answer the question before
 * anybody starts pressing things.
 */
const HOST_QUIET_MS = 3000;
let hostQuiet = false;

function checkHostAwake() {
  const quiet = (net.client?.msSinceHostUpdate ?? 0) > HOST_QUIET_MS;
  if (quiet === hostQuiet) return;
  hostQuiet = quiet;
  setNetHint(
    quiet
      ? "Waiting for the host — their phone may have gone to sleep. Everyone's still connected."
      : null,
  );
}

function connectMultiplayer() {
  if (net.socket) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  let sock;
  try {
    sock = new WebSocket(url);
  } catch {
    setNetStatus('offline');
    return;
  }
  sock.binaryType = 'arraybuffer';
  net.socket = sock;
  setNetStatus('connecting');

  const transport = new BridgeTransport((_to, data) => {
    if (sock.readyState === WebSocket.OPEN) sock.send(data);
  });
  transport.addPeer({ id: 'host', name: 'host', rtt: -1 });
  net.transport = transport;

  // Until MatchStart arrives there is no world to attach a MatchClient to, so
  // hold a temporary handler. MatchClient replaces these events on construction.
  transport.setEvents({ onPacket: (from, data) => net.dispatch?.(from, data) });

  // Announce ourselves. A host running a lobby seats us from this; a host that
  // starts immediately ignores it, because MatchHost drops anything that is not
  // an Input packet. So this is safe to send either way.
  sock.addEventListener('open', () => {
    // A successful open clears the backoff, so the next drop retries promptly
    // rather than inheriting a long delay from an earlier bad patch.
    reconnectDelay = 0;
    reconnectFailures = 0;
    setNetHint(null);
    wantConnection = true;
    const w = new Writer();
    writeLobbyJoin(w, localPlayerName());
    transport.send('host', w.finish(), true);

    /*
     * Say something if the host never answers.
     *
     * Opening the URL after the match has already started is the ordinary way
     * to arrive late at somebody's kitchen table, and it lands in a gap: the
     * socket connects, the Join is sent, and nothing comes back. The host's
     * lobby handler has been replaced by `MatchHost` for the duration of the
     * match, so there is no Welcome and no roster until the next round begins.
     *
     * With the socket healthy no reconnect hint ever fires, so the page showed
     * a perfectly normal single-player game -- which is the worst possible
     * answer, because it looks like it is working. The player has no way to
     * tell they are not in the match everyone else is playing.
     *
     * The wait is deliberate rather than immediate: a host that is sitting in
     * its lobby replies in milliseconds, and flashing this at everyone who
     * joins normally would be noise.
     */
    clearTimeout(waitingForHost);
    waitingForHost = setTimeout(() => {
      if (!net.roster && !net.client) {
        setNetHint('Connected. Waiting for the host to start the next round…');
      }
    }, 2000);
  });

  sock.onmessage = (ev) => transport.receive('host', new Uint8Array(ev.data));
  net.dispatch = (from, data) => {
    // The server restarts the match whenever someone joins or leaves, so
    // MatchStart can arrive at any time -- including long after MatchClient has
    // taken over. Keep dispatch here and forward the rest.
    const r = new Reader(data);
    const type = r.u8();
    if (type === MsgType.Lobby) {
      // The host is talking to us after all.
      clearTimeout(waitingForHost);
      try {
        handleLobbyMessage(r);
      } catch (err) {
        // A malformed roster must not take the screen down mid-lobby.
        console.warn('[lobby]', err);
      }
      return;
    }
    if (type === MsgType.MatchStart) {
      clearTimeout(waitingForHost);
      setNetHint(null);
      try {
        beginNetworkedMatch(readMatchStart(r));
      } catch (err) {
        setNetStatus('version mismatch');
        console.error(err);
        sock.close();
      }
      return;
    }
    net.client?.handlePacket(from, data);
  };
  sock.onerror = () => setNetStatus('offline');
  sock.onclose = () => {
    clearTimeout(waitingForHost);
    net.socket = null;
    net.client = null;
    scheduleReconnect();
  };
}

/* --- staying connected ---------------------------------------------------
 *
 * A dropped socket used to be permanent: status went to "offline" and the only
 * way back was knowing to reload the page. On a phone that is not an edge case,
 * it is the normal course of an evening -- the screen sleeps, the tab gets
 * suspended, somebody walks to the other end of the garden. Installed to the
 * home screen there is not even an obvious reload gesture.
 */

/** Backoff between attempts, in ms. */
let reconnectDelay = 0;
let reconnectTimer = null;
/** Set once we have connected at all, so a solo page never starts polling. */
let wantConnection = false;

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 5000;

/** Consecutive failed attempts, for deciding when to stop being quiet. */
let reconnectFailures = 0;

/** Attempts before saying something. About five seconds of backoff. */
const HINT_AFTER_FAILURES = 4;

function scheduleReconnect() {
  if (!wantConnection || reconnectTimer) return;
  reconnectDelay = reconnectDelay ? Math.min(reconnectDelay * 2, RECONNECT_MAX) : RECONNECT_MIN;
  reconnectFailures++;
  setNetStatus('reconnecting');
  if (reconnectFailures >= HINT_AFTER_FAILURES) {
    setNetHint(
      "Can't reach the host. Check you're still on their hotspot, and that they haven't closed the game.",
    );
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMultiplayer();
  }, reconnectDelay);
}

/**
 * Retry the moment the page is looked at again.
 *
 * Backgrounded tabs get their timers throttled to near-nothing on iOS, so the
 * backoff alone can leave someone staring at "reconnecting" for many seconds
 * after unlocking their phone -- exactly when they are watching.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!wantConnection || net.socket) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelay = 0;
  connectMultiplayer();
});

/* --- lobby ---------------------------------------------------------------
 *
 * The host is authoritative: tapping a team sends a request and changes
 * nothing locally, then the roster comes back and the UI follows it. Two people
 * tapping the same team at once is ordinary, and an optimistic local change
 * leaves two phones disagreeing about who is on which side until the match
 * starts -- the worst moment to find out.
 */

function handleLobbyMessage(r) {
  const op = r.u8();
  if (op === LobbyOp.Roster) {
    net.roster = readRoster(r);
    const mine = net.roster.slots.find((x) => x.slotId === net.mySlotId);
    // Follow the host's view of our own ready flag rather than our last tap.
    if (mine) net.ready = mine.ready;
    renderLobby();
  } else if (op === LobbyOp.Welcome) {
    // A broadcast roster cannot say which row is us; this is the only thing
    // that can.
    net.mySlotId = r.u8();
    renderLobby();
  }
}

function sendLobby(build) {
  if (!net.transport) return;
  const w = new Writer();
  build(w);
  net.transport.send('host', w.finish(), true);
}

function renderLobby() {
  const el = document.getElementById('match-lobby');
  if (!net.roster) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const slots = net.roster.slots;
  const list = document.getElementById('lobby-slots');
  list.innerHTML = '';
  for (const slot of slots) {
    const li = document.createElement('li');
    if (slot.slotId === net.mySlotId) li.dataset.you = 'true';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = teamColor(slot.team);
    li.appendChild(dot);

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = slot.name || 'Player';
    li.appendChild(who);

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [slot.isHost ? 'host' : '', slot.ready ? 'ready' : '']
      .filter(Boolean)
      .join(' · ');
    li.appendChild(tag);

    list.appendChild(li);
  }

  // Offer one team per seat, so free-for-all is reachable with a full lobby and
  // 2v2 is reachable by everyone picking from the first two.
  //
  // The bound was `TEAM_COLORS.length * 2` when there were four colours, which
  // was not a statement about teams at all -- it was doubling a short palette
  // to reach eight, accepting that two teams would wear the same colour. There
  // is a colour per seat now, so the palette is a real bound and says so.
  const teamCount = Math.max(2, Math.min(slots.length, TEAM_COLORS.length));
  const mine = slots.find((x) => x.slotId === net.mySlotId);
  const buttons = document.getElementById('lobby-team-buttons');
  buttons.innerHTML = '';
  for (let team = 0; team < teamCount; team++) {
    const b = document.createElement('button');
    b.textContent = `T${team + 1}`;
    b.style.color = teamColor(team);
    b.setAttribute('aria-pressed', String(mine ? mine.team === team : false));
    b.addEventListener('click', () => sendLobby((w) => writeLobbySetTeam(w, team)));
    buttons.appendChild(b);
  }

  const ready = document.getElementById('btn-ready');
  ready.setAttribute('aria-pressed', String(net.ready));
  ready.textContent = net.ready ? 'Ready' : 'Not ready';
}

document.getElementById('btn-ready').addEventListener('click', () => {
  const next = !net.ready;
  sendLobby((w) => writeLobbySetReady(w, next));
});

function beginNetworkedMatch(start) {
  const map = missionById(start.mapId);
  if (!map) {
    setNetStatus('unknown map');
    return;
  }
  // Rebuild the host's world exactly: same arena, same seed, same roster order.
  const world = createWorld({
    arena: loadArena(map),
    seed: start.seed,
    players: start.players,
    bots: start.bots,
  });

  // Start our clock ahead of the host. A client running behind can never apply
  // a snapshot, because the tick it describes is one we have not simulated yet.
  world.tick = start.hostTick + CLIENT_LEAD_TICKS;

  // MatchStart also arrives at the start of every later round, so the counter
  // is only reset when this is the first one of a match.
  if (!net.client) {
    net.round = 1;
    net.scores = [];
    net.matchOver = false;
    net.banner = null;
  }

  // The match is starting, so the lobby has done its job.
  document.getElementById('match-lobby').hidden = true;

  state.world = world;
  state.outcome = null;
  state.particles.length = 0;
  net.client = new MatchClient(world, net.transport, 'host', start.yourTankId);
  // MatchClient grabs the transport events in its constructor; take them back
  // so MatchStart keeps reaching us.
  net.transport.setEvents({ onPacket: (from, data) => net.dispatch?.(from, data) });
  setNetStatus(`player ${start.yourTankId + 1}`);

  document.getElementById('map-name').textContent = map.name;
  document.getElementById('map-index').textContent = `${start.players.length}P`;
  resize();
}

/** Maps world units to canvas pixels; recomputed on resize. */
let view = { scale: 1, ox: 0, oy: 0 };

function loadMap(i) {
  state.mapIndex = ((i % ALL_MAPS.length) + ALL_MAPS.length) % ALL_MAPS.length;
  let map = ALL_MAPS[state.mapIndex];

  // Campaign missions have a single spawn and scripted enemies, so they cannot
  // seat a second player. Slide to the first versus arena instead of silently
  // dropping player two onto player one's spawn.
  if (state.localPlayers > 1 && loadArena(map).spawns.length < state.localPlayers) {
    state.mapIndex = ALL_MAPS.indexOf(VERSUS_MAPS[0]);
    map = ALL_MAPS[state.mapIndex];
  }
  const arena = loadArena(map);

  // Versus maps ship with no scripted enemies so the same map can serve
  // free-for-all or teams, so fill the spare spawns with bots -- otherwise the
  // map loads empty and there is nothing to test the feel against. Uses the
  // same bots config the host sends over the wire, so single-player and
  // networked matches build their rosters through one code path.
  const seats = state.localPlayers;
  const players = [];
  for (let p = 0; p < seats; p++) players.push({ team: p, spawnIndex: p });

  const bots = [];
  const kinds = [TankKind.Grey, TankKind.Teal, TankKind.Green];
  if (arena.enemies.length === 0) {
    // Up to a good match, not up to the map's capacity. The maps carry eight
    // starts so a full lobby has somewhere to stand; that is not a reason to
    // put seven bots in a solo game.
    const fillTo = Math.min(DEFAULT_MATCH_SIZE, arena.spawns.length);
    for (let s = seats; s < fillTo; s++) {
      bots.push({ kind: kinds[(s - seats) % kinds.length], team: 90 + s, spawnIndex: s });
    }
  }
  state.world = createWorld({ arena, seed: 1000 + state.mapIndex, players, bots });

  state.outcome = null;
  state.outcomeTimer = 0;
  state.particles.length = 0;
  document.getElementById('map-name').textContent = map.name;
  document.getElementById('map-index').textContent = `${state.mapIndex + 1}/${ALL_MAPS.length}`;
  resize();
}

function playerTank() {
  // In a networked match every human is a Player-kind tank, so identity comes
  // from the id the host assigned us, not from the kind.
  if (net.client) return state.world.tanks.find((t) => t.id === net.client.localTankId);
  return state.world.tanks.find((t) => t.kind === TankKind.Player);
}

function setLocalPlayers(n) {
  state.localPlayers = n;
  document.getElementById('btn-2p').setAttribute('aria-pressed', String(n > 1));
  document.getElementById('seat-hint').hidden = n < 2;
  document.getElementById('stat-enemies-label').textContent = n > 1 ? 'Alive' : 'Enemies';
  document.body.dataset.seats = String(n);
  loadMap(state.mapIndex);
}

function resize() {
  const wrap = document.getElementById('stage');
  const rect = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  const a = state.world.arena;
  // Letterbox: the whole arena must always be visible. Being able to see every
  // bank shot coming is load-bearing for this game -- never crop or scroll.
  const scale = Math.min(canvas.width / a.width, canvas.height / a.height);
  view = {
    scale,
    ox: (canvas.width - a.width * scale) / 2,
    oy: (canvas.height - a.height * scale) / 2,
  };
}

function toWorld(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / r.width;
  return {
    x: ((clientX - r.left) * dpr - view.ox) / view.scale,
    y: ((clientY - r.top) * dpr - view.oy) / view.scale,
  };
}

// --- Input ---------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  input.keys.add(k);
  // Latch fire on the keydown itself. A quick tap can go down and up entirely
  // between two frames, and polling the held-keys set would miss it.
  if (k === 'f') input.seatFire[0] = true;
  if (k === 'enter') {
    input.seatFire[1] = true;
    input.fireLatch = true;
  }
  // And the mine, for exactly the same reason. It had the latch on the touch
  // button but not on the key, so a quick tap of the spacebar was dropped
  // whenever it fell between two frames -- reliably at 60fps if you tap the
  // way you would tap a button.
  if (k === ' ') input.mineLatch = true;
  if (k === 't') state.showTrajectory = !state.showTrajectory;
  if (k === 'g') state.showDebug = !state.showDebug;
  if (!net.client) {
    if (k === 'r') loadMap(state.mapIndex);
    if (k === '[') loadMap(state.mapIndex - 1);
    if (k === ']') loadMap(state.mapIndex + 1);
  }
  if (k === 'p') state.running = !state.running;
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => input.keys.delete(e.key.toLowerCase()));

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const p = toWorld(e.clientX, e.clientY);
  input.pointer.x = p.x;
  input.pointer.y = p.y;
  input.pointer.active = true;
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    handleTouchStart(e);
    return;
  }
  input.pointer.down = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') {
    handleTouchEnd(e);
    return;
  }
  input.pointer.down = false;
});

/**
 * Touch: left half of the screen drives, right half aims. Both are relative
 * sticks -- they anchor wherever the thumb lands rather than at a fixed spot,
 * which is what makes a virtual stick usable without looking at it.
 */
function handleTouchStart(e) {
  const left = e.clientX < window.innerWidth / 2;
  const stick = {
    id: e.pointerId,
    ox: e.clientX,
    oy: e.clientY,
    x: e.clientX,
    y: e.clientY,
    startedAt: performance.now(),
  };
  if (left) input.driveStick = stick;
  else input.aimStick = stick;
  canvas.setPointerCapture(e.pointerId);
}

/**
 * Right thumb: drag to aim, tap to fire.
 *
 * Firing continuously while the aim stick is held would mean you can never
 * line up a shot without taking it, which is exactly wrong for a game whose
 * skill ceiling is patient bank shots. So a short, near-stationary press is
 * read as a tap and fires; anything longer or further is aiming only.
 */
function handleTouchEnd(e) {
  let releasedLeft = false;
  if (input.driveStick?.id === e.pointerId) {
    const s = input.driveStick;
    const moved = Math.hypot(s.x - s.ox, s.y - s.oy);
    // In couch play the left half is a seat too, so it needs its own tap-fire.
    releasedLeft = performance.now() - s.startedAt < 250 && moved < 12;
    input.driveStick = null;
  }
  if (input.aimStick?.id === e.pointerId) {
    const s = input.aimStick;
    const moved = Math.hypot(s.x - s.ox, s.y - s.oy);
    if (performance.now() - s.startedAt < 250 && moved < 12) {
      input.fireLatch = true;
      input.seatFire[1] = true;
    }
    input.aimStick = null;
  }
  if (releasedLeft && state.localPlayers > 1) input.seatFire[0] = true;
}
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') return;
  if (input.driveStick?.id === e.pointerId) {
    input.driveStick.x = e.clientX;
    input.driveStick.y = e.clientY;
  }
  if (input.aimStick?.id === e.pointerId) {
    input.aimStick.x = e.clientX;
    input.aimStick.y = e.clientY;
  }
});
canvas.addEventListener('pointercancel', handleTouchEnd);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

document.getElementById('btn-fire').addEventListener('pointerdown', () => (input.fireLatch = true));
document.getElementById('btn-mine').addEventListener('pointerdown', () => (input.mineLatch = true));
document.getElementById('btn-prev').addEventListener('click', () => loadMap(state.mapIndex - 1));
document.getElementById('btn-next').addEventListener('click', () => loadMap(state.mapIndex + 1));
document.getElementById('btn-restart').addEventListener('click', () => loadMap(state.mapIndex));
document.getElementById('btn-2p').addEventListener('click', () => {
  setLocalPlayers(state.localPlayers > 1 ? 1 : 2);
});
/*
 * The diagnostics, reachable from a phone.
 *
 * `G` toggles the same readout, and that was the only way in -- which meant
 * the numbers that answer "why will this not play" were unavailable on the
 * only hardware the game runs on. The build stamp already answers the other
 * half of that question, so it carries both.
 */
document.getElementById('btn-build').addEventListener('click', (e) => {
  state.showDebug = !state.showDebug;
  e.currentTarget.setAttribute('aria-pressed', String(state.showDebug));
});
document.getElementById('btn-traj').addEventListener('click', (e) => {
  state.showTrajectory = !state.showTrajectory;
  e.currentTarget.setAttribute('aria-pressed', String(state.showTrajectory));
});

/**
 * Buttons keep keyboard focus after a pointer click, so a later Enter or Space
 * re-activates whichever button was last touched -- pressing Enter to fire
 * would toggle 2P back off. Drop focus after pointer-driven clicks, but keep it
 * for real keyboard activation (detail === 0) so tabbing still works.
 *
 * The lobby's buttons need this as much as the header's and were missed. You
 * tap a team, you tap Ready, the match starts -- and the first time you press
 * Enter to shoot, you also re-send a team change or un-ready yourself, because
 * that button still has focus behind the hidden panel.
 */
for (const btn of document.querySelectorAll('header button, footer button')) {
  btn.addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
  });
}

// Delegated, because the team buttons do not exist until a roster arrives and
// binding at load time would miss every one of them.
document.getElementById('match-lobby').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && e.detail > 0) btn.blur();
});

const STICK_RANGE = 55;

function gatherInput() {
  const inp = emptyInput();
  const tank = playerTank();
  if (!tank || !tank.alive) return inp;

  // Keyboard drive.
  let mx = 0;
  let my = 0;
  if (input.keys.has('a') || input.keys.has('arrowleft')) mx -= 1;
  if (input.keys.has('d') || input.keys.has('arrowright')) mx += 1;
  if (input.keys.has('w') || input.keys.has('arrowup')) my -= 1;
  if (input.keys.has('s') || input.keys.has('arrowdown')) my += 1;

  // Touch drive stick overrides.
  if (input.driveStick) {
    const dx = input.driveStick.x - input.driveStick.ox;
    const dy = input.driveStick.y - input.driveStick.oy;
    const len = Math.hypot(dx, dy);
    if (len > 6) {
      const f = Math.min(len, STICK_RANGE) / STICK_RANGE / len;
      mx = dx * f;
      my = dy * f;
    }
  }
  inp.moveX = mx;
  inp.moveY = my;

  // Aim: mouse position is the closest desktop analogue to the Wii pointer,
  // and it is what makes the original feel the way it does -- the turret goes
  // where you point, independent of where the tank is driving.
  if (input.aimStick) {
    const dx = input.aimStick.x - input.aimStick.ox;
    const dy = input.aimStick.y - input.aimStick.oy;
    if (Math.hypot(dx, dy) > 8) {
      input.aimHold = { x: dx, y: dy };
    }
    inp.aimX = input.aimHold.x;
    inp.aimY = input.aimHold.y;
  } else if (input.aimHold && !input.pointer.active) {
    // Hold the last touch-aimed direction after the thumb lifts.
    inp.aimX = input.aimHold.x;
    inp.aimY = input.aimHold.y;
  }
  if (input.pointer.active) {
    inp.aimX = input.pointer.x - tank.x;
    inp.aimY = input.pointer.y - tank.y;
  }

  inp.fire = inp.fire || input.pointer.down || input.keys.has('enter') || input.fireLatch;
  inp.layMine = input.keys.has(' ') || input.mineLatch;
  input.fireLatch = false;
  input.mineLatch = false;
  return inp;
}

/**
 * Input for one seat in couch play.
 *
 * Two thumbs cannot drive four sticks, so each seat collapses to a single
 * stick: the tank drives where it points and the turret points the same way.
 * That does cost the thing that makes the real game feel the way it does --
 * driving one direction while shooting another -- so this is the compromise
 * mode, not the control scheme the phone app should ship.
 */
function gatherSeatInput(seat) {
  const inp = emptyInput();
  const tank = state.world.tanks.find((t) => t.id === seat);
  if (!tank || !tank.alive) return inp;

  const stick = seat === 0 ? input.driveStick : input.aimStick;
  const hold = input.seatHold[seat];

  if (stick) {
    const dx = stick.x - stick.ox;
    const dy = stick.y - stick.oy;
    const len = Math.hypot(dx, dy);
    if (len > 8) {
      hold.x = dx;
      hold.y = dy;
      const f = Math.min(len, STICK_RANGE) / STICK_RANGE / len;
      inp.moveX = dx * f;
      inp.moveY = dy * f;
    }
  }

  // Keyboard seats, so couch play is testable without a touchscreen.
  let kx = 0;
  let ky = 0;
  if (seat === 0) {
    if (input.keys.has('a')) kx -= 1;
    if (input.keys.has('d')) kx += 1;
    if (input.keys.has('w')) ky -= 1;
    if (input.keys.has('s')) ky += 1;
  } else {
    if (input.keys.has('arrowleft')) kx -= 1;
    if (input.keys.has('arrowright')) kx += 1;
    if (input.keys.has('arrowup')) ky -= 1;
    if (input.keys.has('arrowdown')) ky += 1;
  }
  if (kx || ky) {
    inp.moveX = kx;
    inp.moveY = ky;
    hold.x = kx;
    hold.y = ky;
  }

  // Turret follows the stick, so aiming and driving are the same gesture.
  inp.aimX = hold.x;
  inp.aimY = hold.y;

  inp.fire = input.seatFire[seat] || input.keys.has(seat === 0 ? 'f' : 'enter');
  input.seatFire[seat] = false;
  return inp;
}

function gatherAllInputs() {
  if (state.localPlayers < 2) {
    const tank = playerTank();
    return new Map([[tank?.id ?? 0, gatherInput()]]);
  }
  const m = new Map();
  for (let seat = 0; seat < state.localPlayers; seat++) m.set(seat, gatherSeatInput(seat));
  return m;
}

// --- Bluetooth match ------------------------------------------------------

function showRadioError(text) {
  const el = document.getElementById('radio-error');
  el.textContent = text;
  el.hidden = false;
}

function renderHostList() {
  const list = document.getElementById('host-list');
  if (!ble.hosts.size) {
    list.innerHTML = '<li class="empty">searching for a host nearby…</li>';
    return;
  }
  list.innerHTML = '';
  for (const h of ble.hosts.values()) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = h.name || h.id;
    btn.addEventListener('click', () => {
      setNetStatus('connecting');
      ble.adapter.connect(h.id);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function ensureBleTransport() {
  if (ble.transport) return ble.transport;
  ble.adapter = createNativeBleAdapter();
  ble.transport = new BleTransport(ble.adapter);
  return ble.transport;
}

/**
 * Host a match over Bluetooth.
 *
 * The host runs the authoritative simulation locally and advertises. Clients
 * that connect are seated into the running world -- unlike the WiFi test
 * harness, which restarted the match on every join, because restarting a match
 * because someone walked into range would be miserable in person.
 */
function hostBluetoothMatch() {
  const transport = ensureBleTransport();
  const map = VERSUS_MAPS[0];
  const arena = loadArena(map);

  const players = [{ team: 0, spawnIndex: 0 }];
  const bots = [];
  const kinds = [TankKind.Grey, TankKind.Teal, TankKind.Green];
  // Same cap as couch play, and unlike couch play no smoke reaches this line:
  // it needs a radio, so it is checked by reading it. Verified by mutation --
  // removing the cap here is not caught by any of the four browser suites.
  for (let sIdx = 1; sIdx < Math.min(DEFAULT_MATCH_SIZE, arena.spawns.length); sIdx++) {
    bots.push({ kind: kinds[(sIdx - 1) % kinds.length], team: 90 + sIdx, spawnIndex: sIdx });
  }

  const seed = 4242;
  const world = createWorld({ arena, seed, players, bots });
  state.world = world;
  state.localPlayers = 1;
  ble.host = new MatchHost(world, transport);
  // The host plays too -- there is no server here, just a phone. Tank 0 is the
  // first player slot created above.
  ble.host.localTankId = world.tanks[0].id;
  ble.role = 'host';
  ble.match = { mapId: map.id, seed, players, bots };

  transport.setEvents({
    onPeerJoin: (peer) => seatBluetoothClient(peer),
    onPeerLeave: () => setNetStatus('hosting'),
    onPacket: (from, data) => ble.host.handlePacket(from, data),
    onError: (err) => showRadioError(err.message),
  });

  transport.host('Tanks!');
  document.getElementById('lobby').hidden = true;
  document.getElementById('map-name').textContent = map.name;
  resize();
}

/**
 * Seat a newly connected client into the running match.
 *
 * Adds a tank for them rather than rebuilding the world, and tells them the
 * host's current tick so their clock starts ahead of ours -- a client running
 * behind can never apply a snapshot.
 */
function seatBluetoothClient(peer) {
  if (!ble.host) return;
  const world = ble.host.world;
  const arena = world.arena;
  const taken = world.tanks.filter((t) => t.kind === TankKind.Player).length;

  /*
   * Refuse rather than stack.
   *
   * There are four spawn points on every versus map and the roster message
   * carries eight slots, so this runs out. It used to fall back to spawns[0],
   * which puts the new arrival on top of whoever already had that corner --
   * two tanks on one square, indistinguishable on screen, killed by the same
   * shell. A player told the match is full can go and watch; a player secretly
   * sharing someone else's tank cannot work out what is happening.
   *
   * Correct whichever way the seat count is settled later: if the maps grow
   * spawn points to match the roster, this simply stops triggering.
   */
  if (taken >= arena.spawns.length) {
    setNetStatus(`hosting · ${taken} joined · full`);
    return;
  }

  const spawn = arena.spawns[taken];

  const tankId = world.nextEntityId++;
  world.tanks.push({
    id: tankId,
    kind: TankKind.Player,
    team: taken,
    alive: true,
    x: spawn.x,
    y: spawn.y,
    bodyAngle: 0,
    turretAngle: 0,
    shellsOut: 0,
    minesOut: 0,
    nextFireTick: 0,
    nextMineTick: 0,
  });

  ble.host.addClient(peer.id, tankId);
  ble.match.players = ble.match.players.concat([{ team: taken, spawnIndex: taken }]);

  const w = new Writer(64);
  writeMatchStart(w, { ...ble.match, hostTick: world.tick, yourTankId: tankId });
  ble.transport.send(peer.id, w.finish(), true);
  setNetStatus(`hosting · ${taken} joined`);
}

/** Look for a host and show what turns up. */
function joinBluetoothMatch() {
  const transport = ensureBleTransport();
  ble.role = 'client';
  ble.hosts.clear();
  renderHostList();

  transport.setEvents({
    onPeerJoin: () => {},
    onPeerLeave: () => setNetStatus('offline'),
    onPacket: (from, data) => {
      const r = new Reader(data);
      if (r.u8() === MsgType.MatchStart) {
        const start = readMatchStart(r);
        const map = missionById(start.mapId);
        if (!map) return;
        const world = createWorld({
          arena: loadArena(map),
          seed: start.seed,
          players: start.players,
          bots: start.bots,
        });
        world.tick = start.hostTick + CLIENT_LEAD_TICKS;
        state.world = world;
        state.localPlayers = 1;
        net.client = new MatchClient(world, transport, from, start.yourTankId);
        transport.setEvents({
          onPacket: (f, d) => net.client.handlePacket(f, d),
          onPeerLeave: () => setNetStatus('host left'),
          onError: (err) => showRadioError(err.message),
        });
        document.getElementById('lobby').hidden = true;
        document.getElementById('map-name').textContent = map.name;
        setNetStatus('playing');
        resize();
        return;
      }
      net.client?.handlePacket(from, data);
    },
    onError: (err) => showRadioError(err.message),
  });

  transport.discover();
  document.getElementById('host-list').hidden = false;
}

// --- Effects -------------------------------------------------------------

function spawnParticles(x, y, count, color, speed, life) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.6);
    state.particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life,
      maxLife: life,
      color,
    });
  }
}

function consumeEvents() {
  for (const ev of state.world.events) {
    switch (ev.kind) {
      case EventKind.ShellBounced:
        spawnParticles(ev.x, ev.y, 4, '#E8C87A', 2.2, 0.22);
        break;
      case EventKind.ShellFired:
        spawnParticles(ev.x, ev.y, 3, '#F0DCA8', 1.4, 0.12);
        break;
      case EventKind.BlockDestroyed:
        spawnParticles(ev.x, ev.y, 10, '#C08A4E', 3.0, 0.5);
        break;
      case EventKind.MineExploded:
        spawnParticles(ev.x, ev.y, 26, '#E07A28', 5.5, 0.6);
        state.shake = Math.max(state.shake, 0.5);
        break;
      case EventKind.TankDestroyed:
        spawnParticles(ev.x, ev.y, 30, '#D9542B', 4.5, 0.7);
        state.shake = Math.max(state.shake, 0.6);
        break;
    }
  }
}

function updateParticles(dt) {
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      state.particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.92;
    p.vy *= 0.92;
  }
  if (state.shake > 0) state.shake = Math.max(0, state.shake - dt * 2.2);
}

// --- Rendering -----------------------------------------------------------

/**
 * Theme token lookup, cached.
 *
 * getComputedStyle forces a style recalc, and the draw code asks for a dozen
 * tokens per frame. Cache them and invalidate only when the theme actually
 * changes -- the viewer's toggle stamps data-theme on the root element, and
 * the OS preference arrives through matchMedia.
 */
let palCache = Object.create(null);
function css(name) {
  let v = palCache[name];
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    palCache[name] = v;
  }
  return v;
}
function invalidatePalette() {
  palCache = Object.create(null);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', invalidatePalette);
new MutationObserver(invalidatePalette).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});

function drawArena() {
  const a = state.world.arena;
  const s = view.scale;

  ctx.fillStyle = css('--ground');
  ctx.fillRect(0, 0, a.width * s, a.height * s);

  // Faint grid. The whole game is geometry, so showing the lattice the shells
  // reflect off makes bank shots legible rather than magic.
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < a.width; x++) {
    ctx.moveTo(x * s, 0);
    ctx.lineTo(x * s, a.height * s);
  }
  for (let y = 1; y < a.height; y++) {
    ctx.moveTo(0, y * s);
    ctx.lineTo(a.width * s, y * s);
  }
  ctx.stroke();

  const wall = css('--wall');
  const wallTop = css('--wall-top');
  const cork = css('--cork');
  const corkTop = css('--cork-top');
  const voidC = css('--void');

  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const t = a.at(x, y);
      if (t === Tile.Floor) continue;
      const px = x * s;
      const py = y * s;

      if (t === Tile.Hole) {
        ctx.fillStyle = voidC;
        ctx.fillRect(px, py, s, s);
        continue;
      }

      // Fake a little height: a darker body plus a lighter top face reads as a
      // block sitting on a table rather than a flat coloured square.
      const lift = s * 0.13;
      ctx.fillStyle = t === Tile.Wall ? wall : cork;
      ctx.fillRect(px, py, s, s);
      ctx.fillStyle = t === Tile.Wall ? wallTop : corkTop;
      ctx.fillRect(px, py - lift, s, s - lift);
    }
  }
}

function drawTank(t, s) {
  const color = t.kind === TankKind.Player ? teamColor(t.team) : KIND_COLORS[t.kind];
  const r = TANK_RADIUS * s;

  ctx.save();
  ctx.translate(t.x * s, t.y * s);

  // Shadow, offset toward the table.
  ctx.fillStyle = css('--shadow');
  ctx.beginPath();
  ctx.ellipse(r * 0.15, r * 0.28, r * 1.02, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hull, oriented along the body angle.
  ctx.save();
  ctx.rotate(t.bodyAngle);
  ctx.fillStyle = color;
  roundRect(-r * 0.95, -r * 0.8, r * 1.9, r * 1.6, r * 0.28);
  ctx.fill();
  // Treads
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(-r * 0.95, -r * 0.92, r * 1.9, r * 0.3);
  ctx.fillRect(-r * 0.95, r * 0.62, r * 1.9, r * 0.3);
  ctx.restore();

  // Turret, independent of the hull. This separation is the core of the
  // control scheme and it should read instantly.
  ctx.save();
  ctx.rotate(t.turretAngle);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, -r * 0.17, r * 1.75, r * 0.34);
  ctx.fillStyle = color;
  ctx.fillRect(0, -r * 0.13, r * 1.7, r * 0.26);
  ctx.restore();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = Math.max(1, s * 0.02);
  ctx.stroke();

  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Trajectory preview.
 *
 * Traces the player's current aim through the real shell physics, including
 * bounces. This is a debug aid rather than a shipping feature -- it would
 * trivialise the game -- but it is the fastest way to confirm by eye that the
 * ricochet code does what the tests say it does.
 */
/**
 * Where this tank's shot would go, as points rather than pixels.
 *
 * Split out from the drawing so it can be compared against a shell that was
 * actually fired. The whole justification for the preview is in the README --
 * it is offered as the fastest way to confirm by eye that the ricochet code
 * does what the tests claim -- and a preview that quietly disagreed with the
 * simulation would refute that in the least visible way possible: it would
 * still look like a plausible bank shot, and it would still be wrong.
 *
 * The step here is 0.2 world units rather than the shell's per-tick distance.
 * That is deliberate and safe: `stepShell` sweeps, so a coarser step lands on
 * the same geometry with fewer segments, and drawing wants segments rather
 * than ticks. `trajectory.test` in smoke.mjs is what keeps that "safe" honest.
 */
function trajectoryPath(tank) {
  const spec = TANK_SPECS[tank.kind];
  const muzzle = TANK_RADIUS + spec.shell.radius + 0.02;
  let x = tank.x + dcos(tank.turretAngle) * muzzle;
  let y = tank.y + dsin(tank.turretAngle) * muzzle;
  let vx = dcos(tank.turretAngle) * spec.shell.speed;
  let vy = dsin(tank.turretAngle) * spec.shell.speed;
  let bounces = spec.shell.maxBounces;

  const points = [{ x, y }];
  const hits = [];
  let travelled = 0;
  while (travelled < 24) {
    const r = stepShell(state.world.arena, x, y, vx, vy, spec.shell.radius, bounces, 0.2, false);
    points.push({ x: r.x, y: r.y });
    for (const b of r.bounces) hits.push(b);
    travelled += Math.hypot(r.x - x, r.y - y) || 0.2;
    x = r.x;
    y = r.y;
    vx = r.vx;
    vy = r.vy;
    bounces = r.bouncesLeft;
    if (r.dead) break;
  }
  return { points, hits };
}

function drawTrajectory(tank, s) {
  const { points, hits } = trajectoryPath(tank);

  ctx.save();
  ctx.setLineDash([s * 0.12, s * 0.12]);
  ctx.lineWidth = Math.max(1.5, s * 0.035);
  ctx.strokeStyle = css('--aim');
  ctx.beginPath();
  ctx.moveTo(points[0].x * s, points[0].y * s);
  for (const p of points.slice(1)) ctx.lineTo(p.x * s, p.y * s);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const h of hits) {
    ctx.beginPath();
    ctx.arc(h.x * s, h.y * s, s * 0.11, 0, Math.PI * 2);
    ctx.fillStyle = css('--aim');
    ctx.fill();
  }
  ctx.restore();
}

function render() {
  const s = view.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = css('--stage-bg');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const shakeX = state.shake > 0 ? (Math.random() - 0.5) * state.shake * s * 0.25 : 0;
  const shakeY = state.shake > 0 ? (Math.random() - 0.5) * state.shake * s * 0.25 : 0;
  ctx.translate(view.ox + shakeX, view.oy + shakeY);

  drawArena();

  const w = state.world;

  // Mines under everything else.
  for (const m of w.mines) {
    const armed = w.tick >= m.armTick;
    const pulse = 0.5 + 0.5 * Math.sin(w.tick * 0.18);
    ctx.fillStyle = armed ? `rgba(224,122,40,${0.45 + pulse * 0.45})` : 'rgba(140,140,140,0.5)';
    ctx.beginPath();
    ctx.arc(m.x * s, m.y * s, s * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = css('--mine-ring');
    ctx.lineWidth = Math.max(1, s * 0.03);
    ctx.beginPath();
    ctx.arc(m.x * s, m.y * s, s * 0.34 * (0.85 + pulse * 0.15), 0, Math.PI * 2);
    ctx.stroke();
  }

  const player = playerTank();
  if (state.showTrajectory && player && player.alive) drawTrajectory(player, s);

  for (const t of w.tanks) {
    if (t.alive) drawTank(t, s);
  }

  // Shells last so they read on top of everything they might hit.
  for (const sh of w.shells) {
    const len = Math.hypot(sh.vx, sh.vy);
    const tx = len > 0 ? sh.vx / len : 0;
    const ty = len > 0 ? sh.vy / len : 0;
    // Motion trail: a plain dot at these speeds reads as a stutter.
    const grad = ctx.createLinearGradient(
      (sh.x - tx * 0.55) * s, (sh.y - ty * 0.55) * s,
      sh.x * s, sh.y * s,
    );
    grad.addColorStop(0, 'rgba(255,214,140,0)');
    grad.addColorStop(1, css('--shell'));
    ctx.strokeStyle = grad;
    ctx.lineCap = 'round';
    ctx.lineWidth = sh.radius * 2 * s;
    ctx.beginPath();
    ctx.moveTo((sh.x - tx * 0.55) * s, (sh.y - ty * 0.55) * s);
    ctx.lineTo(sh.x * s, sh.y * s);
    ctx.stroke();

    ctx.fillStyle = css('--shell');
    ctx.beginPath();
    ctx.arc(sh.x * s, sh.y * s, sh.radius * s * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of state.particles) {
    const k = p.life / p.maxLife;
    ctx.globalAlpha = k;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x * s - s * 0.04, p.y * s - s * 0.04, s * 0.08, s * 0.08);
  }
  ctx.globalAlpha = 1;

  drawSticks();
}

function drawSticks() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = canvas.width / canvas.getBoundingClientRect().width;
  for (const stick of [input.driveStick, input.aimStick]) {
    if (!stick) continue;
    const ox = stick.ox * dpr;
    const oy = stick.oy * dpr;
    const dx = (stick.x - stick.ox) * dpr;
    const dy = (stick.y - stick.oy) * dpr;
    const len = Math.hypot(dx, dy);
    const cap = STICK_RANGE * dpr;
    const f = len > cap ? cap / len : 1;

    ctx.strokeStyle = css('--stick');
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(ox, oy, cap, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = css('--stick-knob');
    ctx.beginPath();
    ctx.arc(ox + dx * f, oy + dy * f, cap * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(view.ox, view.oy);
}

// --- HUD -----------------------------------------------------------------

/** Which team the local player is on, or -2 when there isn't one. */
function myTeam() {
  const id = net.client?.localTankId;
  const tank = state.world.tanks.find((t) => t.id === id);
  return tank ? tank.team : -2;
}

function teamLabel(team) {
  return `T${team + 1}`;
}

/** The last round result we reacted to, by identity. */
let seenRound = null;

/**
 * Rounds and the scoreboard.
 *
 * Without this the whole match is invisible: rounds end, the score changes and
 * somebody eventually wins, and every player sees only tanks appearing and
 * disappearing with no idea why.
 */
function updateRoundsHud() {
  const el = document.getElementById('rounds');
  // Rounds are a networked concept; solo play has none.
  if (!net.client) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const result = net.client.lastRound;
  if (result !== seenRound) {
    seenRound = result;
    if (result) {
      net.scores = result.scores;
      net.matchOver = result.matchOver;
      if (!result.matchOver) net.round += 1;

      const drew = result.winner === DRAW;
      const won = !drew && result.winner === myTeam();
      net.banner = {
        text: drew
          ? 'Draw'
          : `${teamLabel(result.winner)} wins the ${result.matchOver ? 'match' : 'round'}`,
        tone: won ? 'win' : 'lose',
        // A match result stays up. A round result has to get out of the way
        // before the next round starts, or it covers its opening seconds --
        // which is when a shell is already in the air.
        until: result.matchOver ? Infinity : performance.now() + 2200,
      };
    }
  }

  document.getElementById('round-label').textContent = net.matchOver
    ? 'Final'
    : `Round ${net.round}`;

  const scores = new Map(net.scores.map((s) => [s.team, s.score]));
  const teams = [
    ...new Set(state.world.tanks.filter((t) => t.kind === TankKind.Player).map((t) => t.team)),
  ].sort((a, b) => a - b);

  const board = document.getElementById('scoreboard');
  board.innerHTML = '';
  for (const team of teams) {
    const li = document.createElement('li');
    li.textContent = `${teamLabel(team)} ${scores.get(team) ?? 0}`;
    li.style.color = teamColor(team);
    if (team === myTeam()) li.dataset.you = 'true';
    board.appendChild(li);
  }
}

function updateHud() {
  const w = state.world;
  const player = playerTank();
  const enemies = w.tanks.filter((t) => t.team !== 0 && t.alive).length;

  document.getElementById('stat-enemies').textContent =
    state.localPlayers > 1 ? w.tanks.filter((t) => t.alive).length : enemies;
  document.getElementById('stat-shells').textContent = player ? `${player.shellsOut}/5` : '-';
  document.getElementById('stat-mines').textContent = player ? `${player.minesOut}/2` : '-';

  updateRoundsHud();

  const banner = document.getElementById('banner');
  const netBanner = net.banner && performance.now() < net.banner.until ? net.banner : null;
  if (netBanner) {
    banner.textContent = netBanner.text;
    banner.dataset.show = 'true';
    banner.dataset.tone = netBanner.tone;
  } else if (state.outcome) {
    banner.textContent = state.outcome;
    banner.dataset.show = 'true';
    banner.dataset.tone = state.outcome === 'Cleared' ? 'win' : 'lose';
  } else {
    banner.dataset.show = 'false';
  }

  const dbg = document.getElementById('debug');
  dbg.hidden = !state.showDebug;
  if (state.showDebug) {
    const avg = state.tickTimes.length
      ? state.tickTimes.reduce((a, b) => a + b, 0) / state.tickTimes.length
      : 0;
    const c = net.client;
    dbg.textContent =
      `tick ${w.tick}  shells ${w.shells.length}  mines ${w.mines.length}  ` +
      `sim ${(avg * 1000).toFixed(0)}µs/tick` +
      (c
        ? `  |  snap ${c.snapshotsApplied} stale ${c.snapshotsStale} ` +
          `reconcile ${c.reconciles} resync ${c.resyncs} err ${c.lastError.toFixed(3)}`
        : '');
  }
}

// --- Loop ----------------------------------------------------------------

const TICK_MS = 1000 / TICK_HZ;
let accumulator = 0;
let last = performance.now();

function frame(now) {
  const elapsed = Math.min(now - last, 250);
  last = now;

  if (state.running && ble.host) {
    // The host runs the authoritative simulation; its own input is local.
    ble.host.setLocalInput(gatherInput());
    ble.host.update(elapsed);
    state.world = ble.host.world;
    consumeEvents();
    updateParticles(elapsed / 1000);
  } else if (state.running && net.client) {
    // MatchClient reassigns .world when it rewinds to reconcile, so re-read it
    // every frame rather than holding a reference that goes stale mid-match.
    net.client.setInput(gatherInput());
    net.client.update(elapsed);
    state.world = net.client.world;
    consumeEvents();
    updateParticles(elapsed / 1000);
    checkHostAwake();
  } else if (state.running) {
    accumulator += elapsed;
    let budget = 8;
    while (accumulator >= TICK_MS && budget-- > 0) {
      accumulator -= TICK_MS;
      const t0 = performance.now();
      step(state.world, gatherAllInputs());
      const dur = performance.now() - t0;
      state.tickTimes.push(dur);
      if (state.tickTimes.length > 120) state.tickTimes.shift();
      consumeEvents();

      if (!state.outcome && isMatchOver(state.world)) {
        const teams = livingTeams(state.world);
        state.outcome = teams.has(0) ? 'Cleared' : 'Destroyed';
        state.outcomeTimer = 0;
      }
    }
    updateParticles(elapsed / 1000);
  }

  if (state.outcome && !net.client) {
    state.outcomeTimer += elapsed;
    // Give the explosion a moment to land before resetting.
    if (state.outcomeTimer > 2200) {
      loadMap(state.outcome === 'Cleared' ? state.mapIndex + 1 : state.mapIndex);
    }
  }

  render();
  updateHud();
  requestAnimationFrame(frame);
}

/**
 * Bridge to the native shell, when running inside the app's WebView.
 *
 * The page owns the simulation and the renderer; native owns the radio. This is
 * the seam -- BleAdapter's sendFrame goes out through here and frames come back
 * in through receive(). Absent on the web, where window.ReactNativeWebView is
 * undefined and everything below is simply never used.
 */
const nativeBridge = window.ReactNativeWebView
  ? {
      post(msg) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      },
      handlers: new Set(),
    }
  : null;

if (nativeBridge) {
  window.__tanksNative = {
    receive(json) {
      let msg;
      try {
        msg = JSON.parse(json);
      } catch {
        return;
      }
      for (const h of nativeBridge.handlers) h(msg);
    },
  };
  nativeBridge.post({ type: 'ready' });
}

/**
 * BleAdapter over the native bridge.
 *
 * This is the whole reason core defines BleAdapter as an interface: the radio
 * lives in another process, so the adapter's job is only to translate. Framing,
 * fragmentation and the reliable/unreliable choice all stay in core, where they
 * are tested against a simulated link with no hardware involved.
 */
function createNativeBleAdapter() {
  const handlers = { frame: null, connected: null, disconnected: null };
  let payloadSize = 178;

  nativeBridge.handlers.add((msg) => {
    switch (msg.type) {
      case 'ble.frame':
        handlers.frame?.(msg.from, base64ToBytes(msg.frame));
        break;
      case 'ble.found':
        ble.hosts.set(msg.peerId, { id: msg.peerId, name: msg.name, rssi: msg.rssi });
        renderHostList();
        break;
      case 'ble.connected':
        handlers.connected?.({ id: msg.peerId, name: msg.name, rtt: -1 });
        setNetStatus('connected');
        break;
      case 'ble.disconnected':
        handlers.disconnected?.(msg.peerId, msg.reason);
        break;
      case 'ble.ready':
        if (typeof msg.payload === 'number' && msg.payload > 20) payloadSize = msg.payload - 2;
        setNetStatus(msg.role === 'host' ? 'hosting' : 'searching');
        break;
      case 'ble.state':
        // A late MTU negotiation can shrink what one write carries. Shrink with
        // it: an oversized write is silently truncated, not rejected, which
        // would corrupt a snapshot rather than drop it.
        if (msg.state === 'mtu' && typeof msg.payload === 'number') {
          payloadSize = Math.max(20, msg.payload - 2);
        }
        break;
      case 'ble.error':
        setNetStatus('radio error');
        console.warn('[ble]', msg.where, msg.message);
        showRadioError(`${msg.where}: ${msg.message}`);
        break;
    }
  });

  return {
    get payloadSize() {
      return payloadSize;
    },
    startAdvertising: async (matchName) => nativeBridge.post({ type: 'ble.host', matchName }),
    stopAdvertising: async () => nativeBridge.post({ type: 'ble.stop' }),
    startScanning: async () => nativeBridge.post({ type: 'ble.discover' }),
    stopScanning: async () => {},
    connect: async (peerId) => nativeBridge.post({ type: 'ble.connect', peerId }),
    disconnect: async () => nativeBridge.post({ type: 'ble.stop' }),
    sendFrame: (to, frame, ack) =>
      nativeBridge.post({ type: 'ble.send', to, frame: bytesToBase64(frame), ack }),
    onFrame: (cb) => (handlers.frame = cb),
    onPeerConnected: (cb) => (handlers.connected = cb),
    onPeerDisconnected: (cb) => (handlers.disconnected = cb),
  };
}

// btoa/atob are the only base64 primitives available in a WebView, and they
// work on binary strings rather than byte arrays.
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Exposed for the automated multiplayer smoke test, which needs to compare
// two clients' worlds against each other.
window.__state = state;
window.__net = net;
// And the aim preview, so a test can check it against a shell really fired.
window.__trajectoryPath = trajectoryPath;
window.__teamColors = TEAM_COLORS;

window.addEventListener('resize', resize);

/*
 * Track the stage, not just the window.
 *
 * `resize()` locks the canvas to whatever `#stage` measured at the time. The
 * first call runs before the flex layout has settled -- fonts still loading,
 * the footer not yet at its final height -- so the canvas was sized from a
 * stage that was ~30-50px taller than the one it ended up in, and nothing ever
 * re-measured because `window.resize` does not fire for a reflow.
 *
 * `#stage` is `position: relative`, so the oversized canvas painted *and hit
 * tested* over the footer beneath it. On a phone that footer is the Fire and
 * Mine buttons: they were drawn on screen, sat under the canvas, and every tap
 * meant for them went to the aim stick instead. Watching the element it is
 * derived from is what keeps the two in agreement however the page reflows.
 */
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => resize()).observe(document.getElementById('stage'));
}
loadMap(0);

// Only look for a host when served over plain HTTP -- that is the LAN test
// server. Opened from a file or a static host there is nothing to connect to,
// and attempting it would just flash a failed connection at the player.
if (location.protocol === 'http:') {
  connectMultiplayer();
} else {
  // The installed web app is served over https, and an https page may not open
  // a ws:// connection to a local IP -- so multiplayer is not merely absent
  // here, it is impossible. Saying so beats leaving someone hunting for a
  // button that cannot exist.
  setNetStatus('solo');
  setNetHint('To play with others, open the http:// address the host phone shows.');
}

// Bluetooth only exists inside the native app; on the web there is no radio to
// offer, so the button stays hidden rather than dangling as a dead end.
if (nativeBridge) {
  const btBtn = document.getElementById('btn-bt');
  btBtn.hidden = false;
  btBtn.addEventListener('click', () => {
    document.getElementById('lobby').hidden = false;
    document.getElementById('radio-error').hidden = true;
  });
  document.getElementById('btn-host').addEventListener('click', hostBluetoothMatch);
  document.getElementById('btn-join').addEventListener('click', joinBluetoothMatch);
  document.getElementById('btn-lobby-close').addEventListener('click', () => {
    document.getElementById('lobby').hidden = true;
    nativeBridge.post({ type: 'ble.stop' });
  });
}

requestAnimationFrame(frame);
