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

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('the simulation only uses the parts of Math that every engine agrees on', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const files = sources(root);
  assert.ok(files.length > 5, `only found ${files.length} sources to scan -- the walk is wrong`);

  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Math' &&
        !ALLOWED.has(node.name.text)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${file.slice(root.length)}:${line + 1} Math.${node.name.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  assert.deepEqual(
    found,
    [],
    'these are implementation-defined, so an Android host and a browser client would ' +
      `disagree in the last bits and desync:\n  ${found.join('\n  ')}\n` +
      `(use dsin/dcos/datan2 from math.ts, or add to ALLOWED with a reason)`,
  );
});
