/**
 * Guard on @tanks/core's *published* shape.
 *
 * Everything else in this package imports `@tanks/core`, which vitest and Metro
 * both alias to the TypeScript source. That alias is right for iteration — it
 * removes a build step between Session A's edits and a reload — but it is also
 * exactly what hid two real bugs, both of which reached main:
 *
 *   1. `main` said `dist/index.js` while tsc emitted `dist/src/index.js`, so the
 *      declared entry point did not exist and no bundler could resolve the
 *      package at all.
 *   2. core used `export const enum`, which tsc *erases entirely*. Consumers
 *      resolving to source got the enums inlined at compile time and saw
 *      nothing wrong; any consumer of the built package got `undefined` at
 *      runtime from `import { TankKind }`.
 *
 * Both were invisible to a suite that only ever reads source. So this file
 * deliberately does NOT import '@tanks/core' — it reaches for the built output
 * by path, which is the artifact a real consumer gets.
 *
 * Requires `npm run build --workspace @tanks/core` first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(here, '../../core');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = JSON.parse(
  fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8'),
) as { main: string; types: string };

describe('@tanks/core package entry points', () => {
  it('emits the file that package.json main advertises', () => {
    const mainPath = path.resolve(coreDir, pkg.main);
    expect(
      fs.existsSync(mainPath),
      `package.json main is "${pkg.main}" but ${mainPath} does not exist. ` +
        `Run: npm run build --workspace @tanks/core`,
    ).toBe(true);
  });

  it('emits the declarations that package.json types advertises', () => {
    const typesPath = path.resolve(coreDir, pkg.types);
    expect(
      fs.existsSync(typesPath),
      `package.json types is "${pkg.types}" but ${typesPath} does not exist.`,
    ).toBe(true);
  });
});

describe('@tanks/core built output has runtime enums', () => {
  // Loaded by path, bypassing the source alias on purpose.
  async function loadBuilt(): Promise<Record<string, unknown>> {
    const mainPath = path.resolve(coreDir, pkg.main);
    return (await import(/* @vite-ignore */ mainPath)) as Record<
      string,
      unknown
    >;
  }

  /**
   * A `const enum` survives typechecking and vanishes from the build, so the
   * only way to catch it is to read the member off the emitted module at
   * runtime. Checking the type is not enough: an erased enum yields `undefined`,
   * and `undefined.Player` throws rather than failing an assertion cleanly.
   */
  const runtimeEnums: Array<[string, string]> = [
    ['TankKind', 'Player'],
    ['Tile', 'Wall'],
    ['EventKind', 'ShellFired'],
  ];

  for (const [enumName, member] of runtimeEnums) {
    it(`exports ${enumName} as a real object with ${enumName}.${member}`, async () => {
      const built = await loadBuilt();
      const e = built[enumName] as Record<string, unknown> | undefined;
      expect(
        e,
        `${enumName} is missing from the built output — it is probably still ` +
          `declared as 'export const enum', which tsc erases.`,
      ).toBeDefined();
      expect(typeof e).toBe('object');
      expect(typeof e![member]).toBe('number');
    });
  }

  it('exports the functions the app drives the sim with', async () => {
    const built = await loadBuilt();
    for (const fn of ['createWorld', 'step', 'loadArena', 'emptyInput']) {
      expect(typeof built[fn], `${fn} missing from built output`).toBe(
        'function',
      );
    }
  });

  it('exports the netcode surface the lobby will need', async () => {
    const built = await loadBuilt();
    for (const sym of ['MatchHost', 'MatchClient', 'BleTransport']) {
      expect(built[sym], `${sym} missing from built output`).toBeDefined();
    }
  });
});
