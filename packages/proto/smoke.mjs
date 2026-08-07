/**
 * Smoke test for the built prototype.
 *
 * Loads the self-contained HTML in a real browser, drives it with keyboard and
 * mouse, cycles every map, and fails on any console error or page exception.
 * A bundling mistake here shows up as a blank page rather than a build error,
 * so this is the only thing that actually proves the artifact works.
 *
 * It also drives the page with two thumbs, which nothing else does. Every other
 * check in this repo uses a keyboard and a mouse -- neither of which exists on
 * the device most players will be holding. For anyone on an iPhone the browser
 * page *is* the game, and touch is the only way they control it.
 *
 * Exits non-zero on failure. It used to print failures and exit 0, which is how
 * a full-screen overlay covering the arena reached a published build with three
 * green ticks behind it.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

/** The container ships a Chromium that may not match the pinned build id. */
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

const SCRATCH = process.env.SHOT_DIR || '/tmp';
const failures = [];
function check(ok, what, detail) {
  if (ok) console.log(`  ok   ${what}`);
  else {
    console.log(`  FAIL ${what}${detail ? ` -- ${detail}` : ''}`);
    failures.push(what);
  }
}

const b = await chromium.launch({ executablePath: findChrome() });
const p = await b.newPage({ viewport: { width: 1000, height: 640 } });
const errors = [];
p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
// Derived, not hardcoded. An absolute path baked in here works only on the
// machine it was written on -- in CI the checkout lives somewhere else, and the
// failure is a browser error about a missing file rather than anything
// pointing at the path.
const PAGE = new URL('./dist/tanks-proto.html', import.meta.url).href;
await p.goto(PAGE);
await p.waitForTimeout(600);

const probe = async () => p.evaluate(() => {
  const c = document.getElementById('arena');
  return {
    canvas: c ? [c.width, c.height] : null,
    map: document.getElementById('map-name').textContent,
    enemies: document.getElementById('stat-enemies').textContent,
  };
});
console.log('initial:', JSON.stringify(await probe()));

// Drive and shoot for a few seconds; the tick counter must advance.
await p.mouse.move(700, 300);
await p.keyboard.down('d');
await p.mouse.down(); await p.waitForTimeout(150); await p.mouse.up();
await p.waitForTimeout(1500);
await p.keyboard.up('d');
await p.keyboard.press('t');   // trajectory on
await p.keyboard.press('g');   // debug on
await p.waitForTimeout(400);

const dbg = await p.evaluate(() => document.getElementById('debug').textContent);
console.log('debug:', dbg);
await p.screenshot({ path: SCRATCH+'/shot-light.png' });

await p.emulateMedia({ colorScheme: 'dark' });
await p.waitForTimeout(300);
await p.screenshot({ path: SCRATCH+'/shot-dark.png' });

// Cycle a couple of maps to be sure none of them throw.
for (let i=0;i<7;i++){ await p.keyboard.press(']'); await p.waitForTimeout(180); }
console.log('after cycling:', JSON.stringify(await probe()));

// Phone-sized, portrait-ish landscape as the game would be held.
await p.setViewportSize({ width: 844, height: 390 });
await p.waitForTimeout(400);
await p.screenshot({ path: SCRATCH+'/shot-phone.png' });

check(errors.length === 0, 'no console errors', errors.join(' | '));
await p.close();

/*
 * ---------------------------------------------------------------------------
 * A phone, held sideways, driven with two thumbs.
 * ---------------------------------------------------------------------------
 *
 * `isMobile: true` turns on meta-viewport emulation, which is what every phone
 * browser does -- so it is the only configuration that describes a player.
 *
 * It used to be off. With it on, `innerWidth` came back 980 on an 844px screen
 * and every touch coordinate landed somewhere other than where the test aimed
 * it. That read like a quirk of the harness. It was the page reporting a
 * missing `<meta name="viewport">`: without one a phone browser assumes a
 * desktop page, lays out at 980 CSS pixels, and scales the result down -- to
 * 40% in portrait, where the Fire button came out 19x10 physical pixels.
 *
 * So every touch check written before that meta landed was measuring a layout
 * no phone ever rendered. With `width=device-width` the layout viewport is the
 * device again, CSS pixels are device pixels, and the coordinates line up.
 */
const ctx = await b.newContext({
  viewport: { width: 844, height: 390 },
  hasTouch: true,
  isMobile: true,
});
const phone = await ctx.newPage();
const phoneErrors = [];
phone.on('console', m => { if (m.type()==='error') phoneErrors.push(m.text()); });
phone.on('pageerror', e => phoneErrors.push('PAGEERROR: ' + e.message));
await phone.goto(PAGE);
await phone.waitForTimeout(700);

console.log('\nphone, touch:');

/*
 * The page must lay out at the size of the phone holding it.
 *
 * Checked first because everything below is measured in CSS pixels, and if the
 * layout viewport is not the device then those pixels are not what a player
 * sees -- they get scaled by however far 980 is from the screen. A touch-target
 * check passing in a coordinate space that is then shrunk to 40% is worse than
 * no check at all: it reports comfort the player does not get.
 */
const layout = await phone.evaluate(() => ({
  inner: innerWidth,
  standards: document.compatMode === 'CSS1Compat',
  viewportMeta: document.querySelector('meta[name=viewport]')?.content ?? null,
}));
check(layout.inner === 844, 'the page lays out at the width of the phone',
  `innerWidth ${layout.inner} on an 844px screen -- missing or wrong viewport meta (${layout.viewportMeta})`);
check(layout.standards, 'the page renders in standards mode, not quirks',
  'no doctype -- the box model shifts under every rule in the stylesheet');

/*
 * Nothing may sit below the fold. `body` is `overflow: hidden`, so anything
 * past the bottom edge is not scrolled to -- it is simply gone, and the footer
 * is where Fire and Mine live.
 */
const fits = await phone.evaluate(() => ({
  body: Math.round(document.body.getBoundingClientRect().height),
  screen: innerHeight,
  footerBottom: Math.round(document.querySelector('footer').getBoundingClientRect().bottom),
}));
check(fits.footerBottom <= fits.screen + 1, 'the whole page fits the screen',
  `body ${fits.body}px and footer ends at ${fits.footerBottom}px on a ${fits.screen}px screen`);

/*
 * Nothing marked `hidden` may be on screen.
 *
 * Checked as a sweep rather than element by element because the bug is not in
 * any one panel -- it is that an author `display` rule silently beats the UA's
 * `[hidden]` rule, so it recurs the moment someone styles a new panel and
 * assumes the attribute still works. Naming elements here would only catch the
 * ones that had already broken.
 */
const leaks = await phone.evaluate(() =>
  [...document.querySelectorAll('[hidden]')]
    .filter((el) => getComputedStyle(el).display !== 'none')
    .map((el) => `${el.tagName.toLowerCase()}#${el.id || '(no id)'} display:${getComputedStyle(el).display}`));
check(leaks.length === 0, 'hidden elements are actually hidden', leaks.join(', '));

// The arena has to be the thing under your thumb. An overlay here is not a
// cosmetic problem: it takes the touches, so the tank never moves.
const overArena = await phone.evaluate(() => {
  const r = document.getElementById('arena').getBoundingClientRect();
  const at = (fx, fy) => document.elementFromPoint(r.x + r.width * fx, r.y + r.height * fy);
  return ['left', 'right'].map((side, i) => {
    const el = at(i === 0 ? 0.2 : 0.8, 0.5);
    return `${side}:${el ? el.id || el.tagName.toLowerCase() : 'none'}`;
  });
});
check(overArena.every((s) => s.endsWith(':arena')), 'both thumb halves land on the arena', overArena.join(' '));

// Coarse pointer: the thumb buttons appear and the keyboard legend goes away.
check(await phone.locator('#btn-fire').isVisible(), 'Fire button shown on a touch device');
check(!(await phone.locator('.desktop-only').first().isVisible()), 'keyboard legend hidden on a touch device');

/*
 * Visible is not the same as tappable.
 *
 * Both thumb buttons were on screen and both were underneath the canvas, which
 * `#stage` positions above them -- so `isVisible()` was true, a screenshot
 * looked right, and every tap went to the aim stick. Ask what is actually at
 * the pixel instead.
 */
const reach = await phone.evaluate(() =>
  ['#btn-fire', '#btn-mine'].map((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const reaches = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit) || hit.parentElement === el);
    };
    const walk = (dx, dy) => { let n = 0; while (n < 40 && reaches(cx + dx * (n + 1), cy + dy * (n + 1))) n++; return n; };
    // The tappable extent, not the drawn box: these are ~45x20 on purpose, and
    // their target is extended past the border so the footer -- and therefore
    // the arena -- keeps its size.
    return { sel, onTop: reaches(cx, cy), w: walk(-1, 0) + walk(1, 0) + 1, h: walk(0, -1) + walk(0, 1) + 1 };
  }));
const buried = reach.filter((r) => !r.onTop).map((r) => r.sel);
check(buried.length === 0, 'the thumb buttons are on top, not under the arena', `buried: ${buried.join(', ')}`);
const small = reach.filter((r) => Math.min(r.w, r.h) < 28);
check(small.length === 0, 'the thumb buttons are big enough to hit',
  small.map((r) => `${r.sel} ${r.w}x${r.h} tappable`).join(', ') || reach.map((r) => `${r.sel} ${r.w}x${r.h}`).join(' '));

// The arena must not spill past the stage that sizes it -- that overflow is
// what buried the buttons, and it is invisible until something lands on it.
const spill = await phone.evaluate(() => {
  const s = document.getElementById('stage').getBoundingClientRect();
  const c = document.getElementById('arena').getBoundingClientRect();
  return { over: Math.round(c.bottom - s.bottom), stage: Math.round(s.height), canvas: Math.round(c.height) };
});
check(spill.over <= 1, 'the arena fits the stage that sizes it',
  `canvas ${spill.canvas}px in a ${spill.stage}px stage, ${spill.over}px over`);

/*
 * The opening screen is a campaign mission, so its three opponents are authored
 * into the map rather than filled in. Stated because the count is the same 4
 * either way and it would be easy to read this as covering the bot filling,
 * which happens only on the versus maps -- see the couch-play check below.
 */
const roster = await phone.evaluate(() => ({
  total: window.__state.world.tanks.length,
  humans: window.__state.world.tanks.filter((t) => t.kind === 0).length,
  authored: window.__state.world.tanks.length - window.__state.world.tanks.filter((t) => t.kind === 0).length,
}));
check(roster.total === 4 && roster.humans === 1,
  'the opening mission is one player against its three scripted enemies',
  `${roster.humans} human(s) and ${roster.authored} enemy/ies`);

/*
 * Every seat has to be told apart from every other seat, at a glance, on a
 * phone, in a fight.
 *
 * The palette had four colours for what became eight seats, and the renderer
 * was the one lookup without a modulo -- so seats 5-8 got `undefined`, which a
 * canvas silently ignores, leaving each late tank wearing whatever colour was
 * painted before it. Both halves are checked here: that there is a colour per
 * seat, and that no two are close enough to be confused.
 *
 * dE76 in CIE Lab rather than an RGB difference, because RGB distance says
 * navy and black are far apart and says two mid greens are far apart, and only
 * one of those is true.
 */
const palette = await phone.evaluate(() => window.__teamColors);
check(Array.isArray(palette) && palette.length >= 8,
  'there is a tank colour for every seat the lobby can fill',
  `${palette && palette.length} colour(s)`);

const dE = (() => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lab = (hexStr) => {
    const [r, g, bl] = [1, 3, 5].map((i) => lin(parseInt(hexStr.slice(i, i + 2), 16) / 255));
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.9505;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.089;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  return (p, q) => {
    const [l1, a1, b1] = lab(p);
    const [l2, a2, b2] = lab(q);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  };
})();

let closest = Infinity;
let closestPair = '';
for (let i = 0; i < palette.length; i++) {
  for (let j = i + 1; j < palette.length; j++) {
    const d = dE(palette[i], palette[j]);
    if (d < closest) { closest = d; closestPair = `${palette[i]} vs ${palette[j]}`; }
  }
}
// 25 is the floor, not the target -- the eight measure 31.3 at their closest
// and the original four measured 39.0. A future colour landing under this is
// two players who cannot find their own tank.
check(closest >= 25, 'no two seats wear colours that could be confused',
  `closest pair ${closest.toFixed(1)} (${closestPair})`);

/*
 * The scoreboard has to hold a full lobby without pushing the page sideways.
 *
 * It is a flex row of chips in the header, written when a match meant two
 * teams and sized by nothing in particular. Eight seats means eight chips, and
 * a header that overflows takes the whole page with it -- the arena included,
 * which is the thing the layout checks above exist to protect.
 *
 * Driven by filling the board directly rather than by playing a match to eight
 * players, because the question is about the layout and nothing else.
 */
const board8 = await phone.evaluate(() => {
  const rounds = document.getElementById('rounds');
  const wasHidden = rounds.hidden;
  const wasInMatch = document.body.dataset.inMatch;
  rounds.hidden = false;
  // A scoreboard only exists for a client in somebody's match, and that state
  // also hides the map switcher, Restart and 2P -- so showing the chips
  // without it measures a layout no player is ever in.
  document.body.dataset.inMatch = 'true';
  const board = document.getElementById('scoreboard');
  const before = board.innerHTML;
  board.innerHTML = '';
  for (let t = 0; t < 8; t++) {
    const li = document.createElement('li');
    li.textContent = `T${t + 1} 0`;
    li.style.color = window.__teamColors[t % window.__teamColors.length];
    board.appendChild(li);
  }
  const out = {
    // `innerWidth`, not `scrollWidth <= innerWidth`. The first version of this
    // check compared those two and could never fail: under mobile emulation the
    // layout viewport grows to fit its content, so both numbers move together
    // and stay equal however far the content spills. Found by mutating the chip
    // spacing to 10rem -- the board went to 1469px, the check still passed, and
    // `innerWidth` had quietly become 1542.
    //
    // The width the page lays out at is the real signal, and it is the same one
    // 'the page lays out at the width of the phone' uses above.
    layoutWidth: window.innerWidth,
    boardWidth: Math.round(board.getBoundingClientRect().width),
    // What the chips cost in height, which is what a phone actually pays.
    header: Math.round(document.querySelector('header').getBoundingClientRect().height),
    share: (() => {
      const cv = document.getElementById('arena').getBoundingClientRect();
      const a = window.__state.world.arena;
      return Math.min(cv.width, cv.height * (a.width / a.height)) / window.innerWidth;
    })(),
  };
  board.innerHTML = before;
  rounds.hidden = wasHidden;
  if (wasInMatch === undefined) delete document.body.dataset.inMatch;
  else document.body.dataset.inMatch = wasInMatch;
  return out;
});
check(board8.layoutWidth === 844,
  'a full lobby of eight scores fits the header',
  `eight chips (${board8.boardWidth}px) widened the layout to ${board8.layoutWidth}, not 844`);
/*
 * And fits it on one row.
 *
 * Width was the only thing asked here, and eight chips can fit the width while
 * wrapping the header -- which costs height, and on this layout a row of
 * header costs about 1.7 times its height in board width, because a 24x14
 * arena on a 2.16:1 screen is limited by height. Eight-way free-for-all on a
 * phone is the worst case the lobby can produce and the one nothing measured.
 *
 * Header height only. The board's share is printed because it is the thing
 * anyone actually cares about, but it cannot be asserted here: the canvas is
 * resized by a ResizeObserver, so inside one synchronous evaluate it still
 * holds the size it had before the chips appeared. Asserting it would have
 * added a condition that cannot move -- it read 66% either way, including
 * against a build with the regression deliberately restored. The board-share
 * assertions live in the checks near the end of this file, where the layout
 * has settled.
 */
check(board8.header <= 44,
  'eight scores leave the header one row',
  `header ${board8.header}px (board ${(board8.share * 100).toFixed(0)}% of the width, ` +
    `reported but not asserted -- see above)`);

/*
 * A full lobby has to leave Ready reachable.
 *
 * Eight slots and eight team buttons is a lot of panel for a phone held
 * landscape, where there are 390px of height in total.
 *
 * This used to settle for "scrolling brings it back", and it passed on that
 * basis for as long as it existed. Rendering a full roster and looking at the
 * picture is what showed what it was passing: 335px of panel against 410px of
 * content, with the last row of team buttons, Ready and the note under it all
 * below the fold, behind a scroll region with no visible bar on a phone. Ready
 * is the only control that starts a match.
 *
 * So the seat list scrolls now and the controls do not, and this asks for that
 * rather than for reachability -- no scrolling required, Ready and every team
 * button inside the panel and inside the viewport.
 *
 * Rendered directly rather than by joining eight phones, because the question
 * is about the layout. Restored afterwards so the checks below still see the
 * page they expect.
 */
const lobby8 = await phone.evaluate(() => {
  const net = window.__net;
  const before = { roster: net.roster, mySlotId: net.mySlotId };
  net.mySlotId = 0;
  net.roster = {
    slots: Array.from({ length: 8 }, (_, i) => ({
      slotId: i, name: `Player ${i + 1}`, team: i, ready: i % 2 === 0,
    })),
  };
  window.__renderLobby();

  const panel = document.querySelector('#match-lobby .panel');
  const ready = document.getElementById('btn-ready');

  // Whether a *player* can scroll, not whether a script can.
  //
  // Setting scrollTop works on an overflow:hidden element, so the first
  // version of this check scrolled the panel itself and passed even with
  // scrolling turned off -- a panel the user cannot move and a button they
  // cannot reach, reported green. Verified by mutating overflow-y to hidden,
  // which it did not catch. Ask the computed style as well.
  const overflows = panel.scrollHeight > panel.clientHeight + 1;
  const scrollable = ['auto', 'scroll'].includes(getComputedStyle(panel).overflowY);

  /*
   * Before any scrolling, because the line below does some.
   *
   * The first version of this sat in the object literal underneath
   * `panel.scrollTop = panel.scrollHeight`, so it asked whether the button was
   * inside the panel *after* the panel had been scrolled to the bottom -- which
   * it always is. Named `unscrolled` and measuring the scrolled state; it
   * passed against a build with the bug deliberately put back, which is the
   * only reason it was caught.
   */
  const unscrolled = (() => {
    const pr = panel.getBoundingClientRect();
    const inside = (el) => {
      const b = el.getBoundingClientRect();
      return b.top >= pr.top - 0.5 && b.bottom <= pr.bottom + 0.5;
    };
    const teams = [...document.querySelectorAll('#lobby-team-buttons button')];
    return inside(ready) && teams.length > 0 && teams.every(inside);
  })();

  // What a player would do when the button is below the fold.
  panel.scrollTop = panel.scrollHeight;
  const r = ready.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const out = {
    teamButtons: document.getElementById('lobby-team-buttons').children.length,
    slots: document.getElementById('lobby-slots').children.length,
    tappable: !!hit && (hit === ready || ready.contains(hit)),
    onScreen: r.bottom <= window.innerHeight + 1 && r.top >= -1,
    reachable: !overflows || scrollable,
    unscrolled,
    overflows,
    scrollable,
    top: Math.round(r.top),
  };

  net.roster = before.roster;
  net.mySlotId = before.mySlotId;
  window.__renderLobby();
  return out;
});
check(lobby8.slots === 8 && lobby8.teamButtons === 8,
  'a full lobby shows every seat and a team for each',
  `${lobby8.slots} slot(s), ${lobby8.teamButtons} team button(s)`);
check(lobby8.tappable && lobby8.onScreen && lobby8.reachable && lobby8.unscrolled,
  'a full lobby keeps Ready and every team button on screen without scrolling',
  `button top ${lobby8.top} in a ${await phone.evaluate(() => window.innerHeight)}px viewport, ` +
    `tappable=${lobby8.tappable} onScreen=${lobby8.onScreen} ` +
    `overflows=${lobby8.overflows} userScrollable=${lobby8.scrollable} ` +
    `insidePanelUnscrolled=${lobby8.unscrolled}`);

const cdp = await ctx.newCDPSession(phone);
const pts = (x, y, id) => [{ x: Math.round(x), y: Math.round(y), id, radiusX: 1, radiusY: 1, force: 1 }];
const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });

const rect = await phone.evaluate(() => document.getElementById('arena').getBoundingClientRect().toJSON());
const LEFT = { x: rect.x + rect.width * 0.2, y: rect.y + rect.height * 0.5 };
const RIGHT = { x: rect.x + rect.width * 0.8, y: rect.y + rect.height * 0.5 };

/*
 * `ownerId`, not `world.shells.length`.
 *
 * Three AI tanks are shooting throughout, so the world's shell count moves on
 * its own. Counting all of them made "a long aim drag does not fire" fail on an
 * enemy's shot -- and, worse, would have let the tap check pass without the tap
 * doing anything.
 */
const tank = () => phone.evaluate(() => {
  const w = window.__state.world;
  const t = w.tanks.find((t) => t.kind === 0);
  return {
    x: t.x, y: t.y, turret: t.turretAngle, alive: t.alive,
    shells: w.shells.filter((s) => s.ownerId === t.id).length,
    mines: w.mines.filter((m) => m.ownerId === t.id).length,
  };
});

/*
 * Every group below restarts first, and every group ends by confirming the
 * player was still alive when it measured.
 *
 * Three AI tanks shoot from the moment the page loads, and a tank that is not
 * being driven is dead about 2.3 seconds in -- then the map auto-restarts 2.2
 * seconds after that. `gatherInput` returns nothing for a dead tank, so a check
 * that drifts past the deadline reports the control as broken when what
 * actually happened is that the AI won. That is a false failure, and worse, an
 * intermittent one: it depends on how slow the runner is.
 *
 * The `alive` assertion is what keeps a real regression distinguishable from a
 * slow machine -- without it, "the Mine button lays a mine" fails identically
 * either way.
 */
/*
 * Buttons are tapped with real touch events, not `locator.tap()`.
 *
 * Playwright waits for an element to hold still across two animation frames
 * before tapping. This page paints a canvas every frame, so that wait ran into
 * seconds -- long enough for the round to end and the map to auto-restart
 * underneath the test. The symptom was "the Mine button lays a mine" failing
 * against a world that had been replaced since the tap.
 */
async function tapButton(sel, id) {
  const box = await phone.locator(sel).boundingBox();
  if (!box) throw new Error(`${sel} has no box -- is it visible?`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await send('touchStart', pts(cx, cy, id));
  await send('touchEnd', []);
}

async function freshRound() {
  await tapButton('#btn-restart', 90);
  await phone.waitForTimeout(250);
}

/*
 * Both thumbs at once, in different directions.
 *
 * This is the whole point of twin-stick, and the one thing a single-finger test
 * cannot show: driving one way while the turret points another. Two live touch
 * points, so `touchMove` carries both -- CDP replaces the full set each time,
 * and sending one point would silently lift the other.
 */
await freshRound();
const start = await tank();
await send('touchStart', pts(LEFT.x, LEFT.y, 1));
await send('touchStart', [...pts(LEFT.x, LEFT.y, 1), ...pts(RIGHT.x, RIGHT.y, 2)]);
for (let i = 1; i <= 8; i++) {
  await send('touchMove', [
    ...pts(LEFT.x + i * 9, LEFT.y, 1),          // left thumb: drive right
    ...pts(RIGHT.x, RIGHT.y - i * 7, 2),        // right thumb: aim up
  ]);
  await phone.waitForTimeout(35);
}
await phone.waitForTimeout(350);
const driving = await tank();
check(driving.alive, 'the player is alive for the twin-stick checks');
check(driving.x - start.x > 0.25, 'left thumb drives the tank', `x ${start.x.toFixed(2)} -> ${driving.x.toFixed(2)}`);
check(Math.abs(driving.turret - start.turret) > 0.2, 'right thumb turns the turret', `turret ${start.turret.toFixed(2)} -> ${driving.turret.toFixed(2)}`);

await send('touchEnd', pts(LEFT.x + 72, LEFT.y, 1));
await send('touchEnd', []);
await phone.waitForTimeout(250);

/*
 * A thumb's worth of movement is enough to drive.
 *
 * The drag above travels 72px, past the stick's whole 55px range, so it says
 * nothing about how little is needed. Raising the drive stick's 6px threshold
 * to 60 survived every suite on the strength of that one long drag -- and a
 * tank that refuses to move for any normal thumb is the control scheme not
 * working. Measured on the way in: 12px moves 0.454 tiles, 20px moves 0.756,
 * 40px moves 1.513. Twenty is comfortably live and far enough above 6 that
 * the threshold itself stays free to tune.
 *
 * There is deliberately no matching check that a *tiny* drag does nothing. I
 * wrote one, and it could not be made to fail: a 4px hold moves 0.000 tiles
 * with the page's deadzone removed entirely, because what actually rejects it
 * is core's own `moveLen > 0.15` gate in sim.ts, and removing *that* still
 * only produces drift below any threshold this check could honestly use. It
 * asserted something true for structural reasons no mutation reaches, which
 * is decoration rather than a test.
 */
{
  await freshRound();
  const before = await tank();
  await send('touchStart', pts(LEFT.x, LEFT.y, 8));
  for (let i = 0; i < 6; i++) {
    await send('touchMove', pts(LEFT.x + 20, LEFT.y, 8));
    await phone.waitForTimeout(50);
  }
  await phone.waitForTimeout(300);
  await send('touchEnd', []);
  const moved = (await tank()).x - before.x;
  console.log(`  20px drag moved ${moved.toFixed(3)} tiles`);
  check(moved > 0.3, 'a small thumb movement drives the tank', `moved ${moved.toFixed(3)} tiles`);
}

/*
 * A long drag is aiming, not firing -- the game is bank shots, and a turret you
 * cannot line up without taking the shot is the wrong game.
 *
 * Sampled after the release, not before it. Firing happens in `handleTouchEnd`,
 * so a check taken while the thumb is still down passes no matter what that
 * function decides.
 */
const afterLongDrag = await tank();
check(afterLongDrag.shells === start.shells, 'a long aim drag does not fire',
  `shells ${start.shells} -> ${afterLongDrag.shells}`);

/*
 * Aim survives the thumb lifting, or you lose your line every time you let go.
 *
 * Measured as *continued* travel toward where the thumb pointed, which is the
 * only thing that distinguishes holding from doing nothing. Asserting the angle
 * simply stays put proved nothing: with no aim input the turret also stays put,
 * so the check passed with the hold deliberately disabled.
 *
 * The turret turns at 9 rad/s and the flick is one frame, so it is still well
 * short of the target at release -- which is what leaves something to observe.
 * Flicking *down* after aiming up maximises that distance.
 */
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const AIM_DOWN = Math.PI / 2;
await freshRound();
// Aim up first, so the flick down has the full half-turn to travel.
await send('touchStart', pts(RIGHT.x, RIGHT.y, 4));
await send('touchMove', pts(RIGHT.x, RIGHT.y - 120, 4));
await phone.waitForTimeout(250);
await send('touchEnd', []);
await send('touchStart', pts(RIGHT.x, RIGHT.y, 5));
await send('touchMove', pts(RIGHT.x, RIGHT.y + 120, 5));
await phone.waitForTimeout(50);
const atRelease = await tank();
await send('touchEnd', []);
await phone.waitForTimeout(350);
const settled = await tank();
const closed = angDiff(atRelease.turret, AIM_DOWN) - angDiff(settled.turret, AIM_DOWN);
check(settled.alive, 'the player is alive for the aim-hold check');
check(closed > 0.4, 'aim holds after the thumb lifts',
  `off target ${angDiff(atRelease.turret, AIM_DOWN).toFixed(2)} -> ${angDiff(settled.turret, AIM_DOWN).toFixed(2)} rad`);

// A short, still press on the right half is a tap, and a tap fires.
await freshRound();
const beforeTap = await tank();
await send('touchStart', pts(RIGHT.x, RIGHT.y, 3));
await phone.waitForTimeout(60);
await send('touchEnd', []);
await phone.waitForTimeout(350);
const afterTap = await tank();
check(afterTap.alive, 'the player is alive for the tap-to-fire check');
check(afterTap.shells > beforeTap.shells, 'a tap on the right half fires', `shells ${beforeTap.shells} -> ${afterTap.shells}`);

/*
 * ...and stops. One tap is one shot, not the trigger held down.
 *
 * Found by mutation: dropping `input.fireLatch = false` from gatherInput()
 * survived this whole suite and the multiplayer one. The latch exists because
 * a quick tap can go down and up between two frames, so it has to outlive the
 * keyup -- but it is meant to be spent on the next frame that reads it. Left
 * set, `inp.fire` is true for ever after the first shot and the tank empties
 * its magazine and keeps refilling it, which is about as visible as a bug
 * gets and had nothing watching for it.
 *
 * Sampled over a window rather than checked once, because a single shell dies
 * on a wall within a second and a snapshot taken after that looks identical to
 * the healthy case. What separates them is whether new ones keep appearing:
 * held fire pins the count at MAX_SHELLS_PER_TANK (5), a tap never exceeds 1.
 */
let peak = 0;
for (let i = 0; i < 20; i++) {
  peak = Math.max(peak, (await tank()).shells);
  await phone.waitForTimeout(100);
}
check(peak <= 2, 'one tap fires one shell, not a stream', `peak own shells in flight: ${peak}`);

// The Mine button is the only way to lay one without a keyboard.
await freshRound();
const beforeMine = await tank();
await tapButton('#btn-mine', 91);
await phone.waitForTimeout(300);
const afterMine = await tank();
check(afterMine.alive, 'the player is alive for the mine check');
check(afterMine.mines > beforeMine.mines, 'the Mine button lays a mine', `mines ${beforeMine.mines} -> ${afterMine.mines}`);

/*
 * And one tap lays one mine. Same latch, same hole: dropping
 * `input.mineLatch = false` survived every suite here too.
 *
 * The margin is narrower than the shell version because a tank may only have
 * MAX_MINES_PER_TANK (2) out at once, so a stuck latch shows up as 2 rather
 * than as a magazine emptying. Still unambiguous: nothing a single tap can do
 * puts a second mine on the floor, and a mine sits there for five seconds, so
 * the window comfortably covers the cooldown that would produce one.
 */
let minePeak = 0;
for (let i = 0; i < 20; i++) {
  minePeak = Math.max(minePeak, (await tank()).mines);
  await phone.waitForTimeout(100);
}
check(minePeak <= 1, 'one tap lays one mine, not a trail', `peak own mines: ${minePeak}`);

/*
 * The aim preview has to agree with the shell.
 *
 * The README offers the trajectory line as the fastest way to confirm by eye
 * that the ricochet code does what the tests claim. That makes the preview a
 * measuring instrument, and nothing had ever checked it against the thing it
 * measures -- pressing `t` and taking a screenshot only proves it drew
 * something. A preview that disagreed with the simulation would fail in the
 * least visible way there is: still a plausible-looking bank shot, still
 * wrong, and wrong precisely while somebody is trusting it to judge the feel.
 *
 * It steps at 0.2 world units where the shell moves per tick, so the two are
 * sampled differently on purpose and cannot be compared point for point. What
 * must hold is that the shell stays on the drawn line. So: take the preview,
 * fire, and for each position the shell passes through, measure the distance
 * to the nearest segment of the line that was drawn before the trigger.
 */
console.log('\naim preview:');
await freshRound();

/*
 * Aimed diagonally first, and this is the part that matters.
 *
 * The first version fired straight ahead, and a straight shot makes the check
 * vacuous for the thing it was written for: cutting the preview's bounce
 * budget to zero survived, because the shell never reached a wall inside the
 * sampled flight and both versions agreed on the one straight segment. Bank
 * shots are the whole reason the preview exists. Measured before and after:
 * straight ahead the shell keeps `bouncesLeft: 1` for its entire life.
 */
await send('touchStart', pts(RIGHT.x, RIGHT.y, 7));
await send('touchMove', pts(RIGHT.x + 90, RIGHT.y - 90, 7));
await phone.waitForTimeout(250);
await send('touchEnd', []);
await phone.waitForTimeout(150);

const previewed = await phone.evaluate(() => {
  const w = window.__state.world;
  const t = w.tanks.find((t) => t.kind === 0);
  return { path: window.__trajectoryPath(t).points, turret: t.turretAngle, id: t.id };
});
check(previewed.path.length > 2, `the preview should be a path, got ${previewed.path.length} points`);


await phone.keyboard.press('Enter');
const flown = await phone.evaluate(async (ownerId) => {
  const seen = [];
  let bounced = false;
  let last = null;
  for (let i = 0; i < 240; i++) {
    const s = window.__state.world.shells.find((s) => s.ownerId === ownerId);
    if (s) {
      if (last !== null && s.bouncesLeft < last) bounced = true;
      last = s.bouncesLeft;
      seen.push({ x: s.x, y: s.y });
    } else if (seen.length) break;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { seen, bounced };
}, previewed.id);

const distToPath = (p, path) => {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
};

const strays = flown.seen.map((p) => distToPath(p, previewed.path)).filter((d) => d > 0.25);
console.log(`  shell sampled at ${flown.seen.length} points, bounced: ${flown.bounced}; ${strays.length} strayed`);
check(flown.seen.length > 5, `the shell should have been sampled while flying, got ${flown.seen.length} points`);
check(flown.bounced, 'the sampled shot must actually bank, or this says nothing about ricochets');
check(
  strays.length === 0,
  'the fired shell follows the previewed line',
  `worst stray ${Math.max(0, ...flown.seen.map((p) => distToPath(p, previewed.path))).toFixed(3)} tiles`,
);

await phone.screenshot({ path: SCRATCH + '/shot-touch.png' });

/*
 * ---------------------------------------------------------------------------
 * Two players on one phone.
 * ---------------------------------------------------------------------------
 *
 * The release notes tell people to tap 2P for this, and nothing had ever
 * exercised it with the input it is for. It is a different code path from solo
 * -- `gatherSeatInput` per seat rather than one `gatherInput` -- where each
 * thumb owns a whole tank instead of half the controls, and the two must not
 * bleed into each other. Sharing a screen is the only multiplayer that needs
 * no second device at all, so it is the one that works everywhere.
 */
console.log('\ntwo players, one phone:');
await tapButton('#btn-2p', 92);
await phone.waitForTimeout(400);

const seats = await phone.evaluate(() => ({
  attr: document.body.dataset.seats,
  pressed: document.getElementById('btn-2p').getAttribute('aria-pressed'),
  seatHint: !document.getElementById('seat-hint').hidden
    && getComputedStyle(document.getElementById('seat-hint')).display !== 'none',
  soloHint: getComputedStyle(document.getElementById('touch-hint')).display !== 'none',
  humans: window.__state.world.tanks.filter((t) => t.kind === 0).length,
  total: window.__state.world.tanks.length,
}));
check(seats.attr === '2' && seats.pressed === 'true', 'the 2P button switches to two seats', JSON.stringify(seats));
check(seats.humans === 2, 'two human tanks are seated', `got ${seats.humans}`);
/*
 * The size of the match, not just the number of humans in it.
 *
 * This is a versus map, so everyone who is not a seat is a bot the page put
 * there. It filled every unclaimed spawn, which was four while the maps had
 * four starts -- and became eight the day they grew to seat a full lobby, so
 * couch play silently went from two humans and two bots to two and six.
 * Nothing failed. The game just got harder, on the phone, in the build that
 * ships.
 */
check(seats.total === 4, 'couch play is two seats and two bots, not the whole map',
  `${seats.humans} human(s) and ${seats.total - seats.humans} bot(s)`);
// One legend or the other, never both: they describe contradictory controls,
// and `#seat-hint` was one of the elements the `hidden` bug used to leak.
check(seats.seatHint && !seats.soloHint, 'couch play shows its own legend and hides the solo one',
  `seat=${seats.seatHint} solo=${seats.soloHint}`);

/*
 * Both thumbs at once, each steering its own tank in a different direction.
 *
 * The seats share one `input` object -- seat 0 reads `driveStick`, seat 1 reads
 * `aimStick` -- so a mistake there shows up as both tanks following one thumb,
 * or one seat freezing. Driving them apart is what makes that visible; driving
 * them the same way would look identical either way.
 */
const twoTanks = () => phone.evaluate(() => {
  const w = window.__state.world;
  return w.tanks.filter((t) => t.kind === 0).sort((a, b) => a.id - b.id)
    .map((t) => ({ id: t.id, x: t.x, y: t.y, alive: t.alive }));
});
/*
 * Retried, because couch play always seats two AI tanks alongside the two
 * humans -- every versus map has four spawns and `loadMap` fills the spare
 * ones. A stationary seat is dead in about a second, so a single attempt makes
 * this test a coin flip on the AI's aim rather than a check on the controls.
 *
 * Restarting immediately before driving buys the full window back; the retry
 * covers the case where a seat is shot inside it anyway. Failing all three
 * attempts is itself worth knowing -- it would mean a seat cannot reliably
 * survive long enough to move.
 */
let moved = null;
for (let attempt = 1; attempt <= 3 && !moved; attempt++) {
  await freshRound();
  const before2p = await twoTanks();
  await send('touchStart', pts(LEFT.x, LEFT.y, 10));
  await send('touchStart', [...pts(LEFT.x, LEFT.y, 10), ...pts(RIGHT.x, RIGHT.y, 11)]);
  /*
   * Driven apart horizontally, not vertically.
   *
   * Both seats spawn along the top of every versus map, so "up" is straight
   * into the wall -- seat 0 managed 0.12 tiles against it while seat 1 drove
   * freely, and the check read as a dead left thumb. Inward is the axis they
   * both have room on.
   */
  for (let i = 1; i <= 5; i++) {
    await send('touchMove', [
      ...pts(LEFT.x + i * 11, LEFT.y, 10),   // seat 0 drives right
      ...pts(RIGHT.x - i * 11, RIGHT.y, 11), // seat 1 drives left
    ]);
    await phone.waitForTimeout(30);
  }
  await phone.waitForTimeout(200);
  const after2p = await twoTanks();
  await send('touchEnd', []);
  const m = after2p.map((t, i) => ({ id: t.id, dx: t.x - before2p[i].x, alive: t.alive }));
  console.log(`  attempt ${attempt}:`, JSON.stringify(m.map((x) => `${x.id}:dx${x.dx.toFixed(2)}${x.alive ? '' : ' DEAD'}`)));
  if (m.every((x) => x.alive)) moved = m;
  else if (attempt === 3) moved = m;
}
check(moved.every((m) => m.alive), 'both seats survive long enough to move',
  moved.filter((m) => !m.alive).map((m) => `seat ${m.id} died`).join(', '));
check(moved[0].dx > 0.2, 'the left thumb drives seat one', `seat 0 dx ${moved[0].dx.toFixed(2)}`);
check(moved[1].dx < -0.2, 'the right thumb drives seat two', `seat 1 dx ${moved[1].dx.toFixed(2)}`);
// The point of two sticks: opposite directions at the same time, not one tank
// dragging the other along.
check(moved[0].dx * moved[1].dx < 0, 'the two seats move independently',
  `dx ${moved[0].dx.toFixed(2)} and ${moved[1].dx.toFixed(2)}`);

await phone.screenshot({ path: SCRATCH + '/shot-2p.png' });

/*
 * ---------------------------------------------------------------------------
 * The diagnostics, from a phone.
 * ---------------------------------------------------------------------------
 *
 * The debug readout carries the numbers that answer "why will this not play"
 * -- snapshots applied and stale, reconciles, resyncs, position error -- and
 * `G` was the only way to it. No phone has a G, so on the one hardware this
 * game runs on they were unreachable, which matters most on the evening
 * somebody first tries it on a real hotspot with no laptop in the room.
 */
console.log('\ndiagnostics:');
const buildBtn = await phone.locator('#btn-build').boundingBox();
check(!!buildBtn, 'the build stamp is on screen');
if (buildBtn) {
  const reachable = await phone.evaluate(() => {
    const el = document.getElementById('btn-build');
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const reaches = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit) || hit.parentElement === el);
    };
    const walk = (dx, dy) => { let n = 0; while (n < 40 && reaches(cx + dx * (n + 1), cy + dy * (n + 1))) n++; return n; };
    return { onTop: reaches(cx, cy), h: walk(0, -1) + walk(0, 1) + 1 };
  });
  check(reachable.onTop, 'the build stamp is the topmost thing at its own centre');
  check(reachable.h >= 28, 'the build stamp is tall enough to tap', `${reachable.h}px tappable`);

  check(!(await phone.locator('#debug').isVisible()), 'diagnostics start hidden');
  await tapButton('#btn-build', 93);
  await phone.waitForTimeout(250);
  check(await phone.locator('#debug').isVisible(), 'tapping the build stamp shows the diagnostics');
  const text = await phone.locator('#debug').textContent();
  console.log('  ', JSON.stringify(text));
  // Solo has no MatchClient, so the netcode half is absent by design -- but the
  // sim half has to be real, or the readout is decoration.
  check(/tick \d+/.test(text ?? ''), 'the readout carries live numbers', text ?? '');

  await tapButton('#btn-build', 94);
  await phone.waitForTimeout(250);
  check(!(await phone.locator('#debug').isVisible()), 'and tapping again puts them away');
}

/*
 * Held upright.
 *
 * The game asks to be played sideways, but nothing stops someone opening the
 * link portrait -- and that is how a link gets opened first, before anyone has
 * read anything. It does not have to be good, but it does have to be playable:
 * the controls reachable, the page not spilling off an edge, and no errors.
 * Portrait is also where the missing viewport meta hurt most, scaling the page
 * to 40%, so it is worth holding the line here specifically.
 */
console.log('\nheld upright:');
await phone.setViewportSize({ width: 390, height: 844 });
await phone.waitForTimeout(500);
const upright = await phone.evaluate(() => {
  const probe = (sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { sel, onTop: !!hit && (hit === el || el.contains(hit) || hit.parentElement === el), r: `${Math.round(r.width)}x${Math.round(r.height)}` };
  };
  const cv = document.getElementById('arena').getBoundingClientRect();
  const st = document.getElementById('stage').getBoundingClientRect();
  return {
    inner: innerWidth,
    overflowX: document.documentElement.scrollWidth - innerWidth,
    footerBottom: Math.round(document.querySelector('footer').getBoundingClientRect().bottom),
    screen: innerHeight,
    arenaSpill: Math.round(cv.bottom - st.bottom),
    buttons: ['#btn-fire', '#btn-mine'].map(probe),
  };
});
console.log('  ', JSON.stringify(upright));
check(upright.inner === 390, 'portrait lays out at the width of the phone', `innerWidth ${upright.inner}`);
check(upright.overflowX <= 0, 'nothing spills off the side in portrait', `${upright.overflowX}px over`);
check(upright.footerBottom <= upright.screen + 1, 'the page still fits the screen in portrait',
  `footer ends at ${upright.footerBottom} on a ${upright.screen}px screen`);
check(upright.arenaSpill <= 1, 'the arena still fits its stage in portrait', `${upright.arenaSpill}px over`);
check(upright.buttons.every((b) => b.onTop), 'the thumb buttons stay reachable in portrait',
  upright.buttons.filter((b) => !b.onTop).map((b) => b.sel).join(', '));
await phone.screenshot({ path: SCRATCH + '/shot-portrait.png' });

check(phoneErrors.length === 0, 'no console errors on the phone page', phoneErrors.join(' | '));

/*
 * The canvas does not follow a phone's pixel ratio all the way up.
 *
 * `resize()` caps the backing store at 2x, and removing that cap survived
 * every check in this file -- because every context above runs at ratio 1,
 * where the cap has nothing to do. Real phones are 2x and 3x. At 3x the canvas
 * would be 9x the pixels of a 1x screen instead of 4x, more than doubling what
 * has to be filled every frame, and this game's whole claim is that it feels
 * right in the hand.
 *
 * Its own context rather than raising the ratio on the phone above: the touch
 * checks there are reasoned in physical pixels -- the Fire button once came
 * out 19x10 of them -- and that reasoning holds because CSS pixels and device
 * pixels coincide at 1x. Changing it under them would quietly move the ground
 * they stand on.
 */
const hidpi = await b.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});
const hidpiPage = await hidpi.newPage();
await hidpiPage.goto(PAGE);
await hidpiPage.waitForTimeout(600);
const scaled = await hidpiPage.evaluate(() => {
  const cv = document.getElementById('arena');
  return { dpr: devicePixelRatio, backing: cv.width, css: Math.round(cv.getBoundingClientRect().width) };
});
check(scaled.dpr === 3, 'the high-density context really reports 3x', JSON.stringify(scaled));
check(
  scaled.backing <= scaled.css * 2 + 1,
  'the canvas backing store is capped at 2x whatever the screen claims',
  `dpr ${scaled.dpr}, ${scaled.css} CSS px wide -> ${scaled.backing} device px`,
);
await hidpi.close();

/*
 * How much of a phone the board actually gets.
 *
 * Found by rendering the page at phone-landscape sizes and looking at it,
 * which nothing here had done: the arena was drawn in the middle third with
 * wide empty margins, at 53% of the width and 35% of the screen. Two causes,
 * both invisible from the code -- a 22rem hint in the header that pushed the
 * stats onto a second row, and a `<dl>` keeping the browser's default
 * `margin: 1em 0` because the rule set only `margin-left`.
 *
 * It costs more than the pixels suggest. An arena is 24x14 and a landscape
 * phone is about 2.16 wide to 1, so the board is limited by *height* -- every
 * pixel of chrome above or below takes about 1.7 pixels of board width with
 * it. Both of those regressions would leave every other check in this file
 * green while the game got quietly smaller, which is the reason this exists.
 *
 * The bar is the consequence rather than the cause, because a header height is
 * legitimately tunable and "can you see the board" is not. 60% against the 66%
 * measured: slack for a font or a button changing, but the 32px of margin
 * would drop it to 59% and fail.
 */
const phoneCtx = await b.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const phoneLandscape = await phoneCtx.newPage();
await phoneLandscape.goto(PAGE);
await phoneLandscape.waitForTimeout(600);
const board = await phoneLandscape.evaluate(() => {
  const cv = document.getElementById('arena').getBoundingClientRect();
  const arena = window.__state.world.arena;
  // The board is letterboxed into the canvas, so its drawn width is whichever
  // of the two fits -- read the aspect off the map rather than assuming 24x14.
  const drawn = Math.min(cv.width, cv.height * (arena.width / arena.height));
  return {
    share: drawn / innerWidth,
    drawn: Math.round(drawn),
    vw: innerWidth,
    vh: innerHeight,
    header: Math.round(document.querySelector('header').getBoundingClientRect().height),
    footer: Math.round(document.querySelector('footer').getBoundingClientRect().height),
  };
});
check(
  board.share > 0.6,
  'a phone held sideways gives the board most of its width',
  `${board.drawn}px of ${board.vw} = ${(board.share * 100).toFixed(0)}%, ` +
    `with ${board.header}px of header and ${board.footer}px of footer above and below it`,
);
await phoneCtx.close();

/*
 * A phone held upright gets told why the game looks wrong.
 *
 * Portrait is the first thing most players see -- a phone opens a URL upright
 * -- and it said nothing. It is not broken there: the controls are
 * drag-anywhere, so it plays. But a 24x14 arena on a 390x844 screen is a strip
 * in the middle of a lot of nothing, 16.3px tiles against 23px in landscape,
 * under a header that wraps to 138px.
 *
 * All three cases, because the interesting failures are the false positives: a
 * hint that never appears is useless, one that appears in landscape covers the
 * game, and one keyed on orientation alone tells a tall desktop window to
 * rotate a phone it is not.
 */
for (const [w, h, touch, what, want] of [
  [390, 844, true, 'phone held upright', true],
  [844, 390, true, 'phone held sideways', false],
  [700, 1000, false, 'a tall desktop window', false],
]) {
  const turnCtx = await b.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
    isMobile: touch,
    hasTouch: touch,
  });
  const turnPage = await turnCtx.newPage();
  await turnPage.goto(PAGE);
  await turnPage.waitForTimeout(400);
  const shown = await turnPage.evaluate(
    () => getComputedStyle(document.getElementById('turn-phone')).display !== 'none',
  );
  check(
    shown === want,
    `${what} ${want ? 'is told to turn it' : 'is left alone'}`,
    `hint ${shown ? 'shown' : 'hidden'} at ${w}x${h}, touch=${touch}`,
  );
  await turnCtx.close();
}

/*
 * The status badge has to be readable in both palettes.
 *
 * It is the only thing that tells a player their connection dropped, and
 * `reconnecting` is exactly when they need to read it. Its colour was fixed at
 * `#FFF6EC` regardless of scheme, which measured 4.79:1 against the orange in
 * light mode and 2.85:1 in dark -- under the 3.0 that WCAG allows even for
 * large text. Dark mode's --aim is a lighter orange, so the same cream that
 * works in one palette fails in the other.
 *
 * Contrast is computed here rather than eyeballed from a screenshot, and it
 * flattens alpha and element opacity before comparing -- the dimmed `offline`
 * state is 0.55 opacity, and comparing its colour to the header without
 * accounting for that would report a ratio nothing on screen has.
 */
for (const scheme of ['light', 'dark']) {
  const schemeCtx = await b.newContext({ viewport: { width: 844, height: 390 }, colorScheme: scheme });
  const schemePage = await schemeCtx.newPage();
  await schemePage.goto(PAGE);
  await schemePage.waitForTimeout(500);
  const contrast = await schemePage.evaluate(() => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lin = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c) => {
      const [r, g, b] = parse(c);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const over = (fg, bg, elOpacity) => {
      const f = parse(fg);
      const k = parse(bg);
      const a = (f[3] ?? 1) * elOpacity;
      return `rgb(${f[0] * a + k[0] * (1 - a)}, ${f[1] * a + k[1] * (1 - a)}, ${f[2] * a + k[2] * (1 - a)})`;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (hi + 0.05) / (lo + 0.05);
    };

    const el = document.getElementById('net-status');
    const was = el.dataset.state;
    const headerBg = getComputedStyle(document.querySelector('header')).backgroundColor;
    const out = {};
    // The filled states only. `offline` is deliberately dimmed to 0.55 and is
    // the one state that says nothing is happening.
    for (const st of ['solo', 'reconnecting', 'connected']) {
      el.dataset.state = st;
      const cs = getComputedStyle(el);
      const op = parseFloat(cs.opacity);
      const bg = cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? headerBg : over(cs.backgroundColor, headerBg, op);
      out[st] = Math.round(ratio(over(cs.color, bg, op), bg) * 100) / 100;
    }
    el.dataset.state = was;
    return out;
  });
  const worst = Math.min(...Object.values(contrast));
  check(
    worst >= 4.5,
    `the connection badge is readable in ${scheme} mode`,
    Object.entries(contrast).map(([k, v]) => `${k} ${v}:1`).join(', '),
  );

  /*
   * And the round banner, which is drawn over the board rather than a panel.
   *
   * Its win and lose colours were fixed whatever the scheme, and against the
   * floor they measured 2.43:1 and 2.99:1 in light mode -- under the 3.0 that
   * WCAG allows even for 4rem text, on the single most important message the
   * game shows. Palette-aware now.
   *
   * The floor is taken as the commonest colour under the text rather than the
   * centre pixel, which on some maps is a wall. It is also only half the
   * story, and the file says so where the halo is defined: sampling every
   * pixel of that band, the worst case is about 1.0 for every tone, because
   * somewhere under the message there is always a block or a tank near enough
   * to its colour to swallow it. No flat colour fixes that; the text-shadow
   * is what does, and this number cannot see it.
   */
  const bannerContrast = await schemePage.evaluate(() => {
    const parse = (c) => c.match(/[\d.]+/g).map(Number);
    const lin = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c) => {
      const [r, g, b] = parse(c);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (hi + 0.05) / (lo + 0.05);
    };

    const cv = document.getElementById('arena');
    const g = cv.getContext('2d');
    const tally = new Map();
    for (let y = Math.floor(cv.height * 0.42); y <= cv.height * 0.58; y += 8) {
      for (let x = Math.floor(cv.width * 0.2); x <= cv.width * 0.8; x += 8) {
        const d = g.getImageData(x, y, 1, 1).data;
        const key = `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    const floor = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const banner = document.getElementById('banner');
    const was = banner.dataset.tone;
    const out = { floor, tones: {} };
    for (const tone of ['win', 'lose', 'draw']) {
      banner.dataset.tone = tone;
      out.tones[tone] = Math.round(ratio(getComputedStyle(banner).color, floor) * 100) / 100;
    }
    if (was === undefined) delete banner.dataset.tone;
    else banner.dataset.tone = was;
    return out;
  });
  const worstTone = Math.min(...Object.values(bannerContrast.tones));
  check(
    worstTone >= 4.5,
    `the round banner is readable over the board in ${scheme} mode`,
    `over ${bannerContrast.floor}: ` +
      Object.entries(bannerContrast.tones).map(([k, v]) => `${k} ${v}:1`).join(', '),
  );
  await schemeCtx.close();
}

await b.close();

/*
 * ble-wiring: taking `onPeerLeave` means taking it from MatchHost.
 *
 * `MatchHost`'s constructor registers `onPeerLeave -> removeClient`, and
 * `setEvents` is documented as last-one-wins per key. So a page that registers
 * its own `onPeerLeave` alongside a host silently removes the unseating: the
 * departed peer keeps its slot, `stepOnce` goes on feeding its tank empty
 * input, and the abandoned sweep never destroys it. That shipped in the
 * Bluetooth host path.
 *
 * Read rather than executed, and not for want of trying. ble-smoke.mjs drives
 * the whole path with a stubbed radio, and *still* cannot see this: the bots
 * shoot an idle tank long before the ten-second sweep would, so the enemy count
 * falls whether or not the host unseated anybody. Deleting the `removeClient`
 * call leaves that suite green -- mutation-tested, not assumed. A source check
 * that genuinely fails is worth more than a behavioural one that cannot.
 */
{
  // Each `setEvents({...})` call, roughly: from the call to the line that
  // closes it at the same indentation. Good enough to tell the three apart.
  //
  // Comments stripped first, and that is not tidiness. The handler in game.js
  // carries a comment explaining why it calls `removeClient`, so the first
  // version of this check matched the *prose* and passed with the call deleted
  // -- it survived the mutation that motivated the whole check.
  const src = readFileSync(new URL('./game.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const blocks = src.split('setEvents({').slice(1).map((s) => s.slice(0, s.indexOf('\n  });')));
  // Host-side means "dispatches into a MatchHost". The client blocks register
  // an `onPeerLeave` too and are right not to call `removeClient` -- they have
  // no host to unseat anyone from -- so a looser test (anything with an
  // `onPeerJoin`, say) fails on them and says nothing true.
  const hostBlocks = blocks.filter((s) => /\.host\.handlePacket/.test(s));
  check(hostBlocks.length === 1, 'ble-wiring: found the host-side setEvents block to check',
    `matched ${hostBlocks.length} blocks of ${blocks.length} -- if a second host path was added, it needs this check too`);
  for (const block of hostBlocks) {
    check(
      !/onPeerLeave/.test(block) || /removeClient/.test(block),
      'ble-wiring: a host-side onPeerLeave calls removeClient',
      'taking that key takes it from MatchHost, which then never unseats a departed peer',
    );
  }
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
if (failures.length) process.exit(1);
