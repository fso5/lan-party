/**
 * The methods TypeScript declares on a native module must be ones it exposes.
 *
 * Third of the boundary checks, after the module's name (nativeNames) and its
 * events (nativeEvents). This one covers the largest surface: sixteen function
 * names across the two modules.
 *
 * ## Why the type checker does not already do this
 *
 * It looks as though it would. `index.ts` has a real class declaration --
 *
 *     declare class TanksLanNativeModule extends NativeModule<TanksLanEvents> {
 *       start(port: number): Promise<number>
 *       ...
 *     }
 *
 * -- and every call through it is checked against those signatures. But that
 * declaration is hand-written, and `requireNativeModule` casts to it. Nothing
 * relates it to the Kotlin. So `tsc` cheerfully verifies the wrapper against a
 * promise the native side may not keep, and a method declared here but not
 * exposed there is a `TypeError: native.stopScanning is not a function` on the
 * phone, at whatever moment that path first runs.
 *
 * Which moment matters. `start` fails the first time anybody hosts and is hard
 * to miss. `stopScanning` and `disconnect` run at the end of a session -- the
 * app would host, play a whole match, and fall over while tidying up.
 *
 * ## Both directions
 *
 * Kotlin exposing something TypeScript never declares is harmless at runtime,
 * so the strict comparison is a judgement rather than a necessity. It is here
 * because the two are equal today and the usual cause of them parting is a
 * half-finished rename -- which is worth a red run in whichever direction it
 * leaves the tree.
 *
 * Text rather than a build: no Android SDK in this container.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MODULES_DIR = join(__dirname, '..', 'modules');

/** `Function("x")` and `AsyncFunction("x")` from a Kotlin module definition. */
function exposedFunctions(source: string): string[] {
  return [...source.matchAll(/\b(?:Async)?Function\s*\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Method names on the `declare class ... extends NativeModule<...>` block.
 *
 * Anchored on that declaration rather than on the whole file, because the file
 * also holds the wrapper object and the event interfaces, and those names are
 * not part of the native contract.
 */
function declaredMethods(source: string): string[] {
  const block = /declare class \w+ extends NativeModule<[^>]*>\s*\{(.*?)\n\}/s.exec(source);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*(\w+)\s*[(:]/gm)].map((m) => m[1]);
}

interface ModuleSurface {
  name: string;
  exposed: string[];
  declared: string[];
}

const MODULES: ModuleSurface[] = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const dir = join(MODULES_DIR, e.name);
    const exposed: string[] = [];
    const walk = (at: string) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'build' || entry.name === '.gradle') continue;
          walk(path);
        } else if (entry.name.endsWith('.kt')) {
          exposed.push(...exposedFunctions(readFileSync(path, 'utf8')));
        }
      }
    };
    walk(dir);
    return {
      name: e.name,
      exposed: [...new Set(exposed)].sort(),
      declared: [...new Set(declaredMethods(readFileSync(join(dir, 'index.ts'), 'utf8')))].sort(),
    };
  });

describe('native module functions', () => {
  /*
   * The check on the check. Both lists come from pattern-matching source text,
   * and two empty lists are equal -- which is the shape of a green run that
   * verified nothing. These counts are what the tree holds today.
   */
  it('found the surface it is meant to be comparing', () => {
    expect(MODULES.map((m) => m.name).sort()).toEqual(['tanks-ble', 'tanks-lan']);
    for (const m of MODULES) {
      expect(m.exposed.length, `${m.name} exposes no Kotlin functions`).toBeGreaterThanOrEqual(7);
      expect(m.declared.length, `${m.name}/index.ts declares no native methods`).toBeGreaterThanOrEqual(7);
    }
  });

  for (const m of MODULES) {
    it(`${m.name} declares exactly what the Kotlin exposes`, () => {
      const missing = m.declared.filter((d) => !m.exposed.includes(d));
      expect(
        missing,
        `${m.name}/index.ts declares ${JSON.stringify(missing)} which the Kotlin does not expose. ` +
          `tsc checks the wrapper against this declaration and never against the module, so this ` +
          `is "native.${missing[0]} is not a function" on the phone, whenever that path first runs.`,
      ).toEqual([]);

      const unused = m.exposed.filter((e) => !m.declared.includes(e));
      expect(
        unused,
        `${m.name} exposes ${JSON.stringify(unused)} that index.ts never declares. Harmless at ` +
          `runtime, but the two are otherwise equal and the usual cause of that is a half-finished ` +
          `rename.`,
      ).toEqual([]);
    });
  }
});
