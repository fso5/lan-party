import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A comment that names a test must name one that exists.
 *
 * Comments in this codebase carry the reasoning, and several of them point at a
 * test by name to say "this is guarded, and here is where". That is a promise,
 * and a renamed test breaks it silently: the explanation stays, the guard it
 * cites is gone, and the next person reads a guarantee nobody is keeping.
 *
 * Not hypothetical. `protocol.ts` cited `every shell profile fits the wire's
 * bounce field` -- the test was real but had been broadened and renamed to
 * cover owner ids too, so the reference resolved to nothing. The guard was
 * fine; the sentence pointing at it had rotted. Found by sweeping for this,
 * which is what turned the sweep into a test.
 *
 * ## What counts as naming a test
 *
 * A backticked phrase of five words or more, in a comment, with no code
 * punctuation in it. That is deliberately narrow: identifiers, expressions and
 * short phrases are all excluded, so what is left is prose-shaped, and prose in
 * backticks in this codebase means a test title. Swept over the whole of
 * `src/` when it was written, it matched exactly one phrase -- the broken one.
 *
 * If a comment ever wants a long backticked phrase that is *not* a test, add it
 * to ALLOWED below with a word about why. An empty allowlist is the honest
 * starting point rather than a claim that none will ever be needed.
 */
const ALLOWED: string[] = [];

const SRC = new URL('../../src/', import.meta.url).pathname;
const TESTS = new URL('../../test/', import.meta.url).pathname;

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

test('every test named in a comment exists', () => {
  const testFiles = filesUnder(TESTS);
  assert.ok(testFiles.length > 5, `only found ${testFiles.length} test files -- the scan is looking in the wrong place`);

  const declared = new Set<string>();
  for (const f of testFiles) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/test\(\s*'([^']+)'/g)) declared.add(m[1]);
    for (const m of src.matchAll(/test\(\s*"([^"]+)"/g)) declared.add(m[1]);
  }
  assert.ok(declared.size > 50, `only parsed ${declared.size} test names -- the matcher is not finding them`);

  const srcFiles = filesUnder(SRC);
  assert.ok(srcFiles.length > 5, `only found ${srcFiles.length} source files -- the scan is looking in the wrong place`);

  const broken: string[] = [];
  for (const f of srcFiles) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('*') && !trimmed.startsWith('//')) return;
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const phrase = m[1];
        if (phrase.split(/\s+/).length < 5) continue;
        if (/[()[\]{}=<>|&;]/.test(phrase)) continue;
        if (declared.has(phrase) || ALLOWED.includes(phrase)) continue;
        broken.push(`${f.replace(SRC, 'src/')}:${i + 1} names \`${phrase}\`, which is not a test`);
      }
    });
  }

  assert.deepEqual(
    broken,
    [],
    `a comment points at a test that does not exist:\n  ${broken.join('\n  ')}\n` +
      `Either the test was renamed -- update the comment -- or the phrase is ordinary prose, ` +
      `in which case add it to ALLOWED in this file.`,
  );
});
