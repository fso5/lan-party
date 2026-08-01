/**
 * Deterministic math.
 *
 * Every function here must produce bit-identical results on every JS engine we
 * ship to (JavaScriptCore on iOS, Hermes on Android, V8 in tests). The IEEE-754
 * spec guarantees that for `+ - * /` and `Math.sqrt`, so those are safe to use
 * directly. It guarantees nothing for `Math.sin`, `Math.cos`, `Math.atan2`,
 * `Math.tan` or `**` -- engines pick their own implementations and disagree in
 * the last bits.
 *
 * That matters more here than in most games. Clients simulate shell ricochets
 * locally from a single spawn event, so a one-ulp difference in a launch angle
 * compounds across bounces until the shell hits on one phone and misses on
 * another. So we implement our own trig from the safe operations only.
 *
 * Nothing in the simulation may call Math.* except sqrt, abs, floor, min, max.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wrap an angle into [-PI, PI) without fmod, which is fine but we want exactness. */
export function wrapAngle(a: number): number {
  // Reduce by whole turns first. Division and floor are both exact operations.
  const turns = Math.floor((a + PI) / TAU);
  return a - turns * TAU;
}

/**
 * sin via a minimax polynomial on the reduced range.
 *
 * We fold the argument into [-PI/2, PI/2] and use a degree-15 odd polynomial.
 * The truncation error of a Taylor series is bounded by its first dropped term,
 * so at degree 15 over this range that is (PI/2)^17/17! ~= 6e-12. (Stopping at
 * degree 11, the obvious choice, gives (PI/2)^13/13! ~= 5.6e-8 -- fine for
 * rendering, but we are feeding this into ricochet angles that compound over
 * several bounces, so the extra two terms are cheap insurance.)
 *
 * What matters more than the absolute error is that it is the *same* error on
 * every device.
 */
export function dsin(a: number): number {
  let x = wrapAngle(a);
  // Fold [PI/2, PI] and [-PI, -PI/2] back into [-PI/2, PI/2]; sin is symmetric
  // about the poles, so this is exact.
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;

  const x2 = x * x;
  // Horner form, coefficients are the Taylor reciprocal factorials.
  let r = -7.647163731819816e-13; // -1/15!
  r = r * x2 + 1.6059043836821613e-10; //  1/13!
  r = r * x2 + -2.5052108385441718e-8; // -1/11!
  r = r * x2 + 2.7557319223985893e-6; //  1/9!
  r = r * x2 + -1.984126984126984e-4; // -1/7!
  r = r * x2 + 8.333333333333333e-3; //  1/5!
  r = r * x2 + -1.6666666666666666e-1; // -1/3!
  r = r * x2 + 1.0;
  return r * x;
}

export function dcos(a: number): number {
  return dsin(a + HALF_PI);
}

const SQRT3 = 1.7320508075688772;
/** tan(PI/12) = 2 - sqrt(3). The reduction threshold below. */
const TAN_PI_12 = 0.2679491924311227;
const PI_6 = 0.5235987755982988;

/**
 * atan on [-1, 1].
 *
 * A plain Taylor series is useless near |x| = 1 -- it converges far too slowly,
 * because the terms only shrink by x^2 each time. So we first apply the angle
 * subtraction identity
 *
 *     atan(x) = PI/6 + atan((x*sqrt3 - 1) / (x + sqrt3))
 *
 * which maps [tan(PI/12), 1] onto [-tan(PI/12), tan(PI/12)]. That leaves every
 * input inside |u| <= 0.268, where the series is bounded by u^17/17 ~= 1e-11
 * after the terms we keep.
 *
 * Used only through datan2, which handles quadrants and the |y| > |x| case.
 */
function atanUnit(x: number): number {
  const neg = x < 0;
  let u = neg ? -x : x;
  let offset = 0;

  if (u > TAN_PI_12) {
    u = (u * SQRT3 - 1) / (u + SQRT3);
    offset = PI_6;
  }

  const u2 = u * u;
  let r = -6.666666666666667e-2; // -1/15
  r = r * u2 + 7.692307692307693e-2; //  1/13
  r = r * u2 + -9.090909090909091e-2; // -1/11
  r = r * u2 + 1.1111111111111111e-1; //  1/9
  r = r * u2 + -1.4285714285714285e-1; // -1/7
  r = r * u2 + 2.0e-1; //  1/5
  r = r * u2 + -3.3333333333333331e-1; // -1/3
  r = r * u2 + 1.0;

  const result = r * u + offset;
  return neg ? -result : result;
}

/**
 * Two-argument arctangent. Returns a value in [-PI, PI].
 *
 * The quadrant folding uses only comparisons and division, so the only
 * approximation is atanUnit, and it is applied to the same reduced input on
 * every platform.
 */
export function datan2(y: number, x: number): number {
  if (x === 0) {
    if (y > 0) return HALF_PI;
    if (y < 0) return -HALF_PI;
    return 0; // atan2(0, 0) is conventionally 0
  }
  const ay = y < 0 ? -y : y;
  const ax = x < 0 ? -x : x;
  // Reduce to |ratio| <= 1 so the polynomial stays in its accurate range.
  let r: number;
  if (ay <= ax) {
    r = atanUnit(ay / ax);
  } else {
    r = HALF_PI - atanUnit(ax / ay);
  }
  if (x < 0) r = PI - r;
  if (y < 0) r = -r;
  return r;
}

/** Shortest signed angular difference from `from` to `to`, in [-PI, PI). */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function rotateToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  if (d > maxStep) return wrapAngle(from + maxStep);
  if (d < -maxStep) return wrapAngle(from - maxStep);
  return wrapAngle(to);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/**
 * Deterministic PRNG (xorshift128). Seeded per match by the host and shipped in
 * the match-start packet, so every client draws the same sequence -- needed for
 * things like mine scatter and AI jitter that must agree across devices.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // Splitmix-style expansion so nearby seeds diverge immediately.
    let s = seed >>> 0;
    this.a = (s = (s + 0x9e3779b9) >>> 0) >>> 0;
    this.b = (s = (s + 0x9e3779b9) >>> 0) ^ 0x85ebca6b;
    this.c = (s = (s + 0x9e3779b9) >>> 0) ^ 0xc2b2ae35;
    this.d = (s = (s + 0x9e3779b9) >>> 0) ^ 0x27d4eb2f;
    // Warm up so the first few draws are not correlated with the seed.
    for (let i = 0; i < 12; i++) this.nextUint();
  }

  nextUint(): number {
    // All ops are on int32s via |0 and >>>, which are exactly specified.
    let t = this.d;
    const s = this.a;
    this.d = this.c;
    this.c = this.b;
    this.b = s;
    t ^= t << 11;
    t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a;
  }

  /** Uniform in [0, 1). */
  next(): number {
    // Divide by 2^32. Exact, since the numerator is an integer < 2^32.
    return this.nextUint() / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Snapshot for state sync / replay. */
  save(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }

  restore(s: [number, number, number, number]): void {
    this.a = s[0];
    this.b = s[1];
    this.c = s[2];
    this.d = s[3];
  }
}
