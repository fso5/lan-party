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
import { existsSync, readdirSync } from 'node:fs';

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

// The Mine button is the only way to lay one without a keyboard.
await freshRound();
const beforeMine = await tank();
await tapButton('#btn-mine', 91);
await phone.waitForTimeout(300);
const afterMine = await tank();
check(afterMine.alive, 'the player is alive for the mine check');
check(afterMine.mines > beforeMine.mines, 'the Mine button lays a mine', `mines ${beforeMine.mines} -> ${afterMine.mines}`);

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
}));
check(seats.attr === '2' && seats.pressed === 'true', 'the 2P button switches to two seats', JSON.stringify(seats));
check(seats.humans === 2, 'two human tanks are seated', `got ${seats.humans}`);
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

await b.close();

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
if (failures.length) process.exit(1);
