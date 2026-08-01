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
   TICK_HZ, EventKind, Tile, TankKind, livingTeams */

const ALL_MAPS = [...MISSIONS, ...VERSUS_MAPS];

const TEAM_COLORS = ['#2E6DA4', '#B33A3A', '#3E8E5A', '#8A5CB8'];
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
};

function setNetStatus(s) {
  net.status = s;
  const el = document.getElementById('net-status');
  el.textContent = s;
  el.dataset.state = s;
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

  sock.onmessage = (ev) => transport.receive('host', new Uint8Array(ev.data));
  net.dispatch = (from, data) => {
    // The server restarts the match whenever someone joins or leaves, so
    // MatchStart can arrive at any time -- including long after MatchClient has
    // taken over. Keep dispatch here and forward the rest.
    const r = new Reader(data);
    if (r.u8() === MsgType.MatchStart) {
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
    setNetStatus('offline');
    net.socket = null;
    net.client = null;
  };
}

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
    for (let s = seats; s < arena.spawns.length; s++) {
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
document.getElementById('btn-traj').addEventListener('click', (e) => {
  state.showTrajectory = !state.showTrajectory;
  e.currentTarget.setAttribute('aria-pressed', String(state.showTrajectory));
});

/**
 * Buttons keep keyboard focus after a pointer click, so a later Enter or Space
 * re-activates whichever button was last touched -- pressing Enter to fire
 * would toggle 2P back off. Drop focus after pointer-driven clicks, but keep it
 * for real keyboard activation (detail === 0) so tabbing still works.
 */
for (const btn of document.querySelectorAll('header button, footer button')) {
  btn.addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
  });
}

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
  const color = t.kind === TankKind.Player ? TEAM_COLORS[t.team] : KIND_COLORS[t.kind];
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
function drawTrajectory(tank, s) {
  const spec = TANK_SPECS[tank.kind];
  const muzzle = TANK_RADIUS + spec.shell.radius + 0.02;
  let x = tank.x + dcos(tank.turretAngle) * muzzle;
  let y = tank.y + dsin(tank.turretAngle) * muzzle;
  let vx = dcos(tank.turretAngle) * spec.shell.speed;
  let vy = dsin(tank.turretAngle) * spec.shell.speed;
  let bounces = spec.shell.maxBounces;

  ctx.save();
  ctx.setLineDash([s * 0.12, s * 0.12]);
  ctx.lineWidth = Math.max(1.5, s * 0.035);
  ctx.strokeStyle = css('--aim');
  ctx.beginPath();
  ctx.moveTo(x * s, y * s);

  let travelled = 0;
  const hits = [];
  while (travelled < 24) {
    const r = stepShell(state.world.arena, x, y, vx, vy, spec.shell.radius, bounces, 0.2, false);
    ctx.lineTo(r.x * s, r.y * s);
    for (const b of r.bounces) hits.push(b);
    travelled += Math.hypot(r.x - x, r.y - y) || 0.2;
    x = r.x;
    y = r.y;
    vx = r.vx;
    vy = r.vy;
    bounces = r.bouncesLeft;
    if (r.dead) break;
  }
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

function updateHud() {
  const w = state.world;
  const player = playerTank();
  const enemies = w.tanks.filter((t) => t.team !== 0 && t.alive).length;

  document.getElementById('stat-enemies').textContent =
    state.localPlayers > 1 ? w.tanks.filter((t) => t.alive).length : enemies;
  document.getElementById('stat-shells').textContent = player ? `${player.shellsOut}/5` : '-';
  document.getElementById('stat-mines').textContent = player ? `${player.minesOut}/2` : '-';

  const banner = document.getElementById('banner');
  if (state.outcome) {
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

  if (state.running && net.client) {
    // MatchClient reassigns .world when it rewinds to reconcile, so re-read it
    // every frame rather than holding a reference that goes stale mid-match.
    net.client.setInput(gatherInput());
    net.client.update(elapsed);
    state.world = net.client.world;
    consumeEvents();
    updateParticles(elapsed / 1000);
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

// Exposed for the automated multiplayer smoke test, which needs to compare
// two clients' worlds against each other.
window.__state = state;
window.__net = net;

window.addEventListener('resize', resize);
loadMap(0);

// Only look for a host when served over plain HTTP -- that is the LAN test
// server. Opened from a file or a static host there is nothing to connect to,
// and attempting it would just flash a failed connection at the player.
if (location.protocol === 'http:') connectMultiplayer();

requestAnimationFrame(frame);
