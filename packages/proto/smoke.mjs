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
 * `hasTouch` without `isMobile`: `isMobile` turns on meta-viewport emulation,
 * which lays the page out at 980px and then scales it, so CSS coordinates stop
 * matching the coordinates touch events are dispatched in. Every tap then lands
 * somewhere other than where the test aimed it, and the failure looks like the
 * game ignoring input.
 */
const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
const phone = await ctx.newPage();
const phoneErrors = [];
phone.on('console', m => { if (m.type()==='error') phoneErrors.push(m.text()); });
phone.on('pageerror', e => phoneErrors.push('PAGEERROR: ' + e.message));
await phone.goto(PAGE);
await phone.waitForTimeout(700);

console.log('\nphone, touch:');

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
const buried = await phone.evaluate(() =>
  ['#btn-fire', '#btn-mine'].filter((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit !== el && !el.contains(hit);
  }));
check(buried.length === 0, 'the thumb buttons are on top, not under the arena', `buried: ${buried.join(', ')}`);

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
check(phoneErrors.length === 0, 'no console errors on the phone page', phoneErrors.join(' | '));

await b.close();

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
if (failures.length) process.exit(1);
