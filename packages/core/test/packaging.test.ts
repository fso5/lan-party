import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The package's declared entry point has to exist and load.
 *
 * Session B hit this while wiring the app (issue #4): `main` said
 * `dist/index.js`, and because the build's `rootDir` was `.` with tests in the
 * include, tsc emitted `dist/src/index.js` instead. Every
 * `import ... from '@tanks/core'` failed to resolve, and `npm run build` exited
 * 0 the whole time -- the build genuinely succeeded, it just wrote somewhere
 * other than what the package advertised.
 *
 * It is fixed: a separate `tsconfig.build.json` emits a flat `dist/`, which is
 * option B of the two they offered. What was missing is this test. They asked
 * for it in as many words -- "a test that does `await import('@tanks/core')`
 * and asserts a couple of exports exist. That fails today and would have caught
 * it."
 *
 * Today the entry point is exercised, but only *incidentally*: the browser
 * smokes import through it, so a broken `main` fails them. That is a guarantee
 * standing on a coincidence -- the day a smoke stops importing the package by
 * name, the guard disappears with no test going red. Asserted directly here.
 */
const ROOT = new URL('../../', import.meta.url).pathname;
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('every path the package declares exists on disk', () => {
  const declared: [string, string][] = [
    ['main', PKG.main],
    ['types', PKG.types],
    ['exports["."].types', PKG.exports['.'].types],
    ['exports["."].default', PKG.exports['.'].default],
  ];
  for (const [field, rel] of declared) {
    assert.ok(rel, `package.json has no ${field}`);
    assert.ok(
      existsSync(join(ROOT, rel)),
      `${field} points at ${rel}, which does not exist after a build -- ` +
        `the build writes somewhere other than what the package advertises, and it exits 0 doing it`,
    );
  }
});

/**
 * And loading it by name gets the real module.
 *
 * By name rather than by path: a relative import would pass while `main`,
 * `exports` and the emitted layout disagreed, which is exactly the failure this
 * exists for. The named exports are spot checks across the surface -- a
 * simulation entry, a protocol entry and a tuning constant -- so an entry point
 * that resolves to something hollow fails too.
 */
test('the package loads through its own name and carries its exports', async () => {
  const mod = await import('@tanks/core');
  for (const name of ['createWorld', 'step', 'MatchHost', 'writeMatchStart', 'TICK_HZ', 'VERSUS_MAPS']) {
    assert.ok(name in mod, `@tanks/core resolved but does not export ${name}`);
  }
  assert.equal(typeof mod.createWorld, 'function', 'createWorld came back as something other than a function');
  assert.ok(Array.isArray(mod.VERSUS_MAPS) && mod.VERSUS_MAPS.length > 0, 'VERSUS_MAPS is empty');
});

/**
 * `files` has to carry whatever the entry point needs.
 *
 * `npm pack` ships only what `files` lists, so a package that resolves in the
 * workspace can still arrive broken: the tarball would be missing the very
 * directory `main` points into. Checked as a containment rule rather than by
 * packing, which would need the network.
 */
test('the published file list covers the declared entry point', () => {
  const listed: string[] = PKG.files ?? [];
  assert.ok(listed.length > 0, 'package.json declares no files, so a pack would ship almost nothing');
  const entry = PKG.main.replace(/^\.\//, '');
  assert.ok(
    listed.some((f: string) => entry === f || entry.startsWith(f.replace(/\/$/, '') + '/')),
    `main is ${PKG.main} but files is [${listed.join(', ')}] -- a pack would not include the entry point`,
  );
});
