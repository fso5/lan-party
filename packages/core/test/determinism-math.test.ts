/**
 * The simulation may only use the parts of `Math` that IEEE-754 pins down.
 *
 * math.ts states this rule in its own header and nothing enforced it. It is
 * the most load-bearing invariant in the project: an Android phone hosts under
 * Hermes while every other player runs a browser under V8 or JavaScriptCore,
 * and the netcode's entire design assumes those engines step the world
 * identically. `Math.sin` and friends are implementation-defined, so engines
 * disagree in the last bits -- and clients re-simulate ricochets locally from
 * one spawn event, so a one-ulp difference in a launch angle compounds across
 * bounces until a shell hits on one phone and misses on another.
 *
 * That failure is invisible here. Every test in this suite runs on one engine,
 * so a forbidden call is green locally and desyncs only in somebody's kitchen,
 * on hardware none of us has. Hence a rule that has to be checked by reading
 * the code rather than by running it.
 *
 * Parsed rather than grepped. A search for `Math.sin` matches math.ts's own
 * docstring, which is where four of the five current mentions live -- and the
 * dangerous error is the other direction, a real call missed because it sits
 * behind a comment or inside a template. The TypeScript parser has no such
 * ambiguity, and it is already a dependency because tsc builds this package.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/*
 * Exactly specified by IEEE-754 or by the language, so every engine agrees.
 *
 * `round` and `ceil` are not in math.ts's list but belong here: both are
 * defined exactly, unlike the transcendental functions. `PI` is a literal
 * double. The list is deliberately short -- anything not on it needs a reason
 * written down, not a quiet addition.
 */
const ALLOWED = new Set(['sqrt', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'PI']);

/*
 * And no clocks in the simulation, for a related but different reason.
 *
 * `determinism.test.ts` does catch a clock read that changes behaviour -- both
 * of its replay tests fail when tank speed is made to depend on `Date.now()`,
 * verified by mutation. But it catches it by luck rather than by construction:
 * it steps its two worlds interleaved, microseconds apart, so a clock-derived
 * term reads the same millisecond for both except on the ticks that straddle a
 * boundary. Over 3000 ticks that is plenty and it fires -- with a coarser
 * clock term it might not.
 *
 * Scoped to the simulation. `net/` is where a clock legitimately belongs: BLE
 * join timeouts are wall-clock by nature, and nothing there feeds the stepped
 * world, which advances on ticks handed to it rather than on time it reads.
 */
const NO_CLOCKS_OUTSIDE = 'net/';
const CLOCKS = new Set(['Date', 'performance']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    // `.d.ts` also ends in `.ts` and contains no implementation at all. The
    // first version of this scanned nothing but declarations -- see below.
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

test('the simulation reads no clock and only the parts of Math every engine agrees on', () => {
  /*
   * Up two, because this runs from `dist-test/test/`.
   *
   * `../src/` resolves to `dist-test/src/`, which holds the compiled output and
   * the `.d.ts` files beside it -- 19 of them, all matching a `.ts` suffix
   * check and none containing a single statement. The first version of this
   * test scanned exactly that, found nothing, and could never have found
   * anything. It passed, and the mutations I ran to "verify" it were caught by
   * `determinism.test.ts` instead, which patches Math at runtime and had been
   * doing this job all along.
   *
   * Hence the assertions below. A scan that silently looks at the wrong place
   * is worse than no scan, so it names files it must find rather than counting
   * what it got.
   */
  const root = new URL('../../src/', import.meta.url).pathname;
  const files = sources(root).map((f) => f.slice(root.length));
  for (const must of ['sim.ts', 'ai.ts', 'math.ts', 'physics.ts', 'net/protocol.ts']) {
    assert.ok(files.includes(must), `the walk missed ${must}, so it is looking in the wrong place`);
  }

  const found: string[] = [];
  for (const where of files) {
    const file = join(root, where);
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      const at = () => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Math' &&
        !ALLOWED.has(node.name.text)
      ) {
        found.push(`${where}:${at()} Math.${node.name.text}`);
      }
      if (!where.startsWith(NO_CLOCKS_OUTSIDE)) {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          CLOCKS.has(node.expression.text)
        ) {
          found.push(`${where}:${at()} ${node.expression.text}.${node.name.text}`);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
          found.push(`${where}:${at()} new Date()`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  assert.deepEqual(
    found,
    [],
    'a stepped world may not depend on the engine or on the wall clock -- an ' +
      'Android host and a browser client would disagree in the last bits, and a ' +
      `replay would not reproduce:\n  ${found.join('\n  ')}\n` +
      `(use dsin/dcos/datan2 from math.ts and the tick count for time, or add a ` +
      `reason to ALLOWED)`,
  );
});
