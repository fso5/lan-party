/**
 * What share of a frame does the *browser* cost?
 *
 *     npm run build -w @tanks/proto && node tools/render-bench.mjs
 *
 * tools/sim-bench.mjs answers this for the simulation. It is the smaller half.
 * The page the host phone serves is what every other player in the room runs --
 * an iPhone cannot run our app without a paid Apple account, so for those
 * people this canvas *is* the game -- and nothing had ever measured what a
 * frame of it costs.
 *
 * The gap showed up in smoke.mjs, which caps the canvas backing store at 2x and
 * says removing the cap "survived every check in this file". It reasons that at
 * 3x the canvas would be "more than doubling what has to be filled every
 * frame". That reasoning is right and was never measured; this measures it.
 *
 * ## What is timed, and what that is worth
 *
 * `requestAnimationFrame` is wrapped before the page loads, so each callback is
 * timed end to end: the simulation ticks, the canvas draw, and the HUD update,
 * which together are everything the page does per frame. The page already
 * records its own tick times in `state.tickTimes`, so the simulation's share is
 * read separately and subtracted.
 *
 * The *duration of the callback* is the number, not the gap between frames.
 * rAF is vsync-paced, so the gap says 16.7ms whether the work took 1ms or 15,
 * right up until it does not -- by which point the answer is already known.
 *
 * Two caveats, both real:
 *
 *   - This box is not a phone, exactly as sim-bench is not a phone. Read the
 *     ratios and the scaling, not the absolute microseconds.
 *   - There is no GPU here, so canvas 2D is drawn in software. That makes this
 *     a pessimistic proxy for a phone rather than an optimistic one, which is
 *     the safer direction for a budget to be wrong in.
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

const PAGE = new URL('../packages/proto/dist/tanks-proto.html', import.meta.url).href;
const BUDGET_MS = 1000 / 60;

// Timed from inside the page, before any of its own code runs, so the very
// first frame is measured too -- that is the one that builds every cache.
//
// The one-pixel readback at the end is not incidental. Without it this
// measured nothing useful: canvas 2D calls are *recorded* during the callback
// and rasterised afterwards, so timing the callback alone times the JS that
// issues drawing commands and not the drawing. The tell was unmistakable --
// 2x the backing store, four times the pixels, came out at 0.86x the cost.
// `getImageData` forces the pipeline to flush before it can answer, which
// folds the rasterisation back into the number.
const INSTRUMENT = `
  window.__frameTimes = [];
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    const a = performance.now();
    cb(t);
    const cv = document.getElementById('arena');
    if (cv) cv.getContext('2d').getImageData(0, 0, 1, 1);
    window.__frameTimes.push(performance.now() - a);
  });
`;

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    p99: s[Math.floor(s.length * 0.99)],
    worst: s[s.length - 1],
  };
}

/*
 * Ten seconds, and p95 next to p99.
 *
 * Six seconds is about 360 frames, which makes p99 the fourth-worst of them --
 * an extreme value rather than a percentile, and one stall owns it. A run of
 * the campaign row came back at 22.50ms p99 with a 49.7ms worst frame, against
 * 2.20ms the run before, from a single hiccup in a container with no GPU. Read
 * p95 when the two disagree by more than a little; that is the page, and the
 * gap between them is the machine.
 */
async function run(b, label, { dpr, seconds = 10, maps = 0 }) {
  const ctx = await b.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: dpr,
    hasTouch: true,
    isMobile: true,
  });
  const p = await ctx.newPage();
  await p.addInitScript(INSTRUMENT);
  await p.goto(PAGE);

  // Step to the requested map, then let the first frames settle before
  // measuring -- the opening frames build caches and are not representative.
  for (let i = 0; i < maps; i++) await p.keyboard.press(']');
  await p.waitForTimeout(1200);
  await p.evaluate(() => { window.__frameTimes.length = 0; });
  await p.waitForTimeout(seconds * 1000);

  const got = await p.evaluate(() => ({
    frames: window.__frameTimes,
    ticks: window.__state.tickTimes.slice(),
    tanks: window.__state.world.tanks.length,
    map: window.__state.world.arena.name,
    backing: document.getElementById('arena').width,
    css: Math.round(document.getElementById('arena').getBoundingClientRect().width),
  }));
  await ctx.close();

  if (got.frames.length === 0) {
    console.log(`${label.padEnd(30)} no frames captured -- the page never animated`);
    return null;
  }

  const f = stats(got.frames);
  const t = got.ticks.length ? stats(got.ticks) : null;
  console.log(
    `${label.padEnd(30)} ${String(got.tanks).padStart(2)} tanks  ` +
      `${String(got.backing).padStart(4)}px backing (${got.css} css)  ` +
      `n ${String(f.n).padStart(3)}  mean ${f.mean.toFixed(2)}ms  p50 ${f.p50.toFixed(2)}ms  ` +
      `p95 ${f.p95.toFixed(2)}ms  p99 ${f.p99.toFixed(2)}ms  worst ${f.worst.toFixed(1)}ms  ` +
      `= ${((f.p95 / BUDGET_MS) * 100).toFixed(1)}% of a frame at p95` +
      (t ? `   [sim ${t.p50.toFixed(2)}ms p50]` : ''),
  );
  return { ...f, tanks: got.tanks, backing: got.backing, map: got.map };
}

const b = await chromium.launch({ executablePath: findChrome() });

console.log(`budget: ${BUDGET_MS.toFixed(2)}ms per frame at 60Hz`);
console.log(`page:   ${PAGE}\n`);

const one = await run(b, 'campaign, 1x backing', { dpr: 1 });
const two = await run(b, 'campaign, 2x backing', { dpr: 2 });
console.log('');
const versus1 = await run(b, 'versus, 1x backing', { dpr: 1, maps: 5 });
const versus2 = await run(b, 'versus, 2x backing', { dpr: 2, maps: 5 });

await b.close();

// The claim smoke.mjs reasons about but cannot see: the backing store is where
// the cost is, so the cap it enforces is load-bearing rather than tidy.
if (one && two) {
  const px = (two.backing / one.backing) ** 2;
  console.log(
    `\n2x costs ${(two.p50 / one.p50).toFixed(2)}x the frame of 1x for ${px.toFixed(0)}x the pixels ` +
      `(campaign)` +
      (versus1 && versus2 ? `, ${(versus2.p50 / versus1.p50).toFixed(2)}x (versus)` : ''),
  );

  /*
   * Sub-linear because only part of a frame scales with area. Split the two
   * apart with the two points measured -- frame = fixed + k*pixels -- and the
   * 3x case follows without having to render at 3x, which the cap in resize()
   * prevents anyway.
   *
   * A two-point fit, so it assumes fill cost is linear in area. That is the
   * right shape for a software rasteriser and it is worth saying out loud
   * rather than leaving implied.
   */
  const perPixel = (two.p50 - one.p50) / (px - 1);
  const fixed = one.p50 - perPixel;
  const three = fixed + perPixel * 9;
  console.log(
    `  fixed cost per frame ${fixed.toFixed(2)}ms (simulation, HUD, issuing the draw)\n` +
      `  fill cost at 1x      ${perPixel.toFixed(2)}ms, so ${(perPixel * 4).toFixed(2)}ms at 2x ` +
      `and ${(perPixel * 9).toFixed(2)}ms at 3x`,
  );
  console.log(
    `\nSo removing the 2x cap in resize() would cost a 3x phone ` +
      `${(three / two.p50).toFixed(2)}x the frame\nit pays now (${three.toFixed(2)}ms against ` +
      `${two.p50.toFixed(2)}ms). smoke.mjs reasons its way to that cap and\nsays removing it ` +
      `"survived every check in this file"; this is the number behind it.`,
  );
  console.log(
    '\nRead the ratios, not the milliseconds. This box has no GPU, so the canvas is\n' +
      'drawn in software -- pessimistic for a phone rather than optimistic, which is\n' +
      'the safer direction for a budget to be wrong in.',
  );
}
