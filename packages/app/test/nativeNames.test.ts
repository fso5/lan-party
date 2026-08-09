/**
 * The name a native module registers must be the name JavaScript asks for.
 *
 * Three strings have to agree for a native module to work, and they live in
 * three languages:
 *
 *   expo-module.config.json   "expo.modules.tankslan.TanksLanModule"
 *   TanksLanModule.kt          Name("TanksLan")
 *   index.ts                   requireNativeModule('TanksLan')
 *
 * The first relationship is checked: the APK step in android.yml looks for
 * `Lexpo/modules/tankslan/TanksLanModule;` in the dex, so autolinking pointed
 * at a class that is missing turns the build red.
 *
 * The second is not checked anywhere, and it is the one that costs a player
 * the evening. `Name()` is what the module registers itself as at runtime;
 * `requireNativeModule` is what JavaScript looks up. Rename one and the class
 * still compiles, still autolinks, still ships in the dex, and the JS string is
 * still in the bundle -- every check we have stays green. The failure arrives on
 * a phone, at the moment somebody taps Host, as "Cannot find native module
 * 'TanksLan'".
 *
 * That is a realistic edit rather than an invented one: the module name, the
 * class name, the package and the directory are four near-identical spellings
 * of the same word, and renaming the module is exactly when someone touches
 * several of them at once.
 *
 * Text, not a build. Neither Kotlin nor Swift can be compiled here -- there is
 * no Android SDK in this container and CoreBluetooth does not exist on Linux,
 * which is why ios-syntax.yml can only parse. Reading the declaration is what
 * is available, and it is enough for this particular mistake.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MODULES_DIR = join(__dirname, '..', 'modules');

interface NativeModuleDecl {
  dir: string;
  /** Classes named in expo-module.config.json, per platform. */
  androidClasses: string[];
  iosClasses: string[];
  /** Name(...) as declared in each native source file that has one. */
  declared: { file: string; name: string }[];
  /** requireNativeModule('...') from index.ts. */
  requested: string[];
}

/** Every `Name("X")` in a Kotlin or Swift module definition. */
function declaredNames(dir: string): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        // build output, never source
        if (entry.name === 'build' || entry.name === '.gradle') continue;
        walk(path);
      } else if (entry.name.endsWith('.kt') || entry.name.endsWith('.swift')) {
        const text = readFileSync(path, 'utf8');
        for (const m of text.matchAll(/^\s*Name\(\s*"([^"]+)"\s*\)/gm)) {
          out.push({ file: path.slice(MODULES_DIR.length + 1), name: m[1] });
        }
      }
    }
  };
  walk(dir);
  return out;
}

function readModules(): NativeModuleDecl[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(MODULES_DIR, e.name);
      const config = JSON.parse(readFileSync(join(dir, 'expo-module.config.json'), 'utf8'));
      const index = readFileSync(join(dir, 'index.ts'), 'utf8');
      return {
        dir: e.name,
        androidClasses: config.android?.modules ?? [],
        iosClasses: config.ios?.modules ?? [],
        declared: declaredNames(dir),
        requested: [...index.matchAll(/requireNativeModule<[^>]*>\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
      };
    });
}

const MODULES = readModules();

describe('native module names', () => {
  /*
   * The check on the check.
   *
   * Everything below is a loop over things found by reading the filesystem, and
   * a loop over nothing passes. If a rename moved the modules, or the `Name(`
   * pattern stopped matching, each `it` below would be vacuously true and this
   * file would keep reporting success about modules it could no longer see.
   */
  it('found the modules it is meant to be checking', () => {
    expect(MODULES.map((m) => m.dir).sort()).toEqual(['tanks-ble', 'tanks-lan']);
    for (const m of MODULES) {
      expect(m.declared.length, `${m.dir} has no Name(...) in any native source`).toBeGreaterThan(0);
      expect(m.requested.length, `${m.dir}/index.ts never calls requireNativeModule`).toBeGreaterThan(0);
      expect(m.androidClasses.length, `${m.dir} declares no Android module class`).toBeGreaterThan(0);
    }
  });

  for (const m of MODULES) {
    describe(m.dir, () => {
      it('registers the name JavaScript asks for', () => {
        for (const requested of m.requested) {
          const names = m.declared.map((d) => d.name);
          expect(
            names,
            `${m.dir}/index.ts requires '${requested}', but the native sources register ` +
              `${JSON.stringify(names)}. The class would still ship and every build check would ` +
              `stay green; the app fails on the phone with "Cannot find native module '${requested}'".`,
          ).toContain(requested);
        }
      });

      it('registers one name per platform, not several', () => {
        // Android and iOS each declare it once, so two entries for a
        // cross-platform module and one for Android-only. Anything else means a
        // stray Name() somewhere -- a second module definition in the same
        // file registers over the first, silently.
        const byName = new Set(m.declared.map((d) => d.name));
        expect(
          [...byName],
          `${m.dir} registers more than one distinct name: ${JSON.stringify(m.declared)}`,
        ).toHaveLength(1);
      });

      it('autolinks a class that exists at the path it names', () => {
        for (const cls of m.androidClasses) {
          // expo.modules.tankslan.TanksLanModule -> .../java/expo/modules/tankslan/TanksLanModule.kt
          const path = join(
            MODULES_DIR,
            m.dir,
            'android',
            'src',
            'main',
            'java',
            ...cls.split('.'),
          );
          expect(
            existsSync(`${path}.kt`),
            `expo-module.config.json autolinks ${cls}, but ${path}.kt does not exist`,
          ).toBe(true);
        }
      });
    });
  }
});
