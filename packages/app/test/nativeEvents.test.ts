/**
 * Every event JavaScript listens for must be one the native module declares.
 *
 * Companion to nativeNames.test.ts, which checks the module's own name. This
 * checks the names of the things it sends, and the failure is quieter still: a
 * listener registered for an event nobody declares is not an error anywhere. It
 * simply never fires. `tanks-ble/index.ts` says what that feels like on a
 * phone -- "no events arriving is very hard to tell apart from the other phone
 * isn't there" -- and `onFrame` is every byte of inbound Bluetooth traffic.
 *
 * Three relationships, in two languages plus the config:
 *
 *   Kotlin  Events("onFrame", ...)        what the module registers
 *   Kotlin  sendEvent("onFrame", ...)     what it actually emits
 *   TS      addListener('onFrame', ...)   what anything is waiting for
 *
 * Expo throws at runtime for a `sendEvent` naming an undeclared event, so that
 * pair fails loudly on a device. The other pair -- a listener with no matching
 * declaration -- fails silently, and is the one worth a test.
 *
 * ## Where the listeners live is not where you would guess
 *
 * `tanks-ble` subscribes inside its own `index.ts`, wrapping each event in a
 * typed helper. `tanks-lan` does not: its `index.ts` only declares the event
 * types, and the actual `addListener` calls are in `src/net/tcpServer.ts`. So
 * this scans both, and a check that looked only at the modules would pass over
 * the entire WiFi path without noticing it had.
 *
 * ## What this does not check, stated so it is not mistaken for coverage
 *
 * Whether the *Swift* module ever emits a given event. It routes every one
 * through a single `self?.sendEvent(name, body)` where `name` is a parameter,
 * so no amount of reading the text answers it. Only the Kotlin's emissions are
 * checked. What is checked for Swift is that it declares the same set as the
 * Kotlin, because a cross-platform module registering two different contracts
 * is a real defect and that much is visible.
 *
 * Text rather than a build, for the same reason as nativeNames.test.ts: no
 * Android SDK here, and CoreBluetooth does not exist on Linux.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(__dirname, '..');
const MODULES_DIR = join(APP, 'modules');

/** `Events("a", "b", ...)` from a native module definition. */
function declaredEvents(source: string): string[] {
  const block = /\bEvents\s*\(([^)]*)\)/s.exec(source);
  return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

/**
 * `sendEvent("name", ...)` names.
 *
 * Multi-line on purpose. Several of these calls put the name on the line after
 * the paren, and a line-anchored pattern reports them as absent -- which for a
 * first pass had me believing the Kotlin never emitted `onFrame` or
 * `onPeerFound`, the two that carry all inbound traffic. It emits both.
 */
function sentEvents(source: string): string[] {
  return [...source.matchAll(/sendEvent\s*\(\s*"([^"]+)"/gs)].map((m) => m[1]);
}

function listenedEvents(source: string): string[] {
  return [...source.matchAll(/addListener\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

interface NativeSource {
  module: string;
  file: string;
  lang: 'kotlin' | 'swift';
  declared: string[];
  sent: string[];
}

function nativeSources(): NativeSource[] {
  const out: NativeSource[] = [];
  const walk = (module: string, at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'build' || entry.name === '.gradle') continue;
        walk(module, path);
      } else if (entry.name.endsWith('.kt') || entry.name.endsWith('.swift')) {
        const source = readFileSync(path, 'utf8');
        const declared = declaredEvents(source);
        if (!declared.length) continue; // not a module definition
        out.push({
          module,
          file: entry.name,
          lang: entry.name.endsWith('.kt') ? 'kotlin' : 'swift',
          declared,
          sent: [...new Set(sentEvents(source))],
        });
      }
    }
  };
  for (const entry of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(entry.name, join(MODULES_DIR, entry.name));
  }
  return out;
}

/** Every file that subscribes: the modules themselves, and the app's adapters. */
function listenerSites(): { file: string; events: string[] }[] {
  const files: string[] = [];
  for (const entry of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    const index = join(MODULES_DIR, entry.name, 'index.ts');
    if (entry.isDirectory() && existsSync(index)) files.push(index);
  }
  const net = join(APP, 'src', 'net');
  for (const name of readdirSync(net)) {
    if (name.endsWith('.ts')) files.push(join(net, name));
  }
  return files
    .map((file) => ({ file: file.slice(APP.length + 1), events: [...new Set(listenedEvents(readFileSync(file, 'utf8')))] }))
    .filter((f) => f.events.length > 0);
}

const SOURCES = nativeSources();
const SITES = listenerSites();
/*
 * Android's declarations, not the union across platforms.
 *
 * The union was the first version and it had a hole big enough to matter:
 * deleting `onFrame` from the Kotlin left the listener check green, because the
 * Swift still declared it. Android is the platform that ships, so a listener
 * matched against a declaration only iOS makes is matched against nothing that
 * runs. Platform parity is asserted separately, below, which is where a Swift
 * that has drifted belongs.
 */
const ALL_DECLARED = new Set(SOURCES.filter((s) => s.lang === 'kotlin').flatMap((s) => s.declared));

describe('native module events', () => {
  /*
   * The check on the check. Every assertion below iterates over something found
   * by reading the filesystem, and every one of them is green over an empty
   * list. These numbers are what the tree holds today.
   */
  it('found the sources and the listeners it is meant to be checking', () => {
    expect(SOURCES.map((s) => `${s.module}/${s.file}`).sort()).toEqual([
      'tanks-ble/TanksBleModule.kt',
      'tanks-ble/TanksBleModule.swift',
      'tanks-lan/TanksLanModule.kt',
    ]);
    expect(SITES.map((s) => s.file).sort()).toEqual([
      'modules/tanks-ble/index.ts',
      'src/net/tcpServer.ts',
    ]);
    expect(ALL_DECLARED.size).toBeGreaterThanOrEqual(6);
  });

  for (const source of SOURCES) {
    it(`${source.module}/${source.file} only sends events it declares`, () => {
      for (const sent of source.sent) {
        expect(
          source.declared,
          `${source.file} sends "${sent}" but does not declare it. Expo raises on an ` +
            `undeclared event, so this is a crash on the phone rather than a silent miss.`,
        ).toContain(sent);
      }
    });
  }

  it('the Kotlin emits every event it declares', () => {
    // Only the Kotlin: the Swift emits through a helper taking the name as a
    // parameter, so its emissions are invisible to text. A declared event that
    // is never sent is a listener that can never fire.
    for (const source of SOURCES.filter((s) => s.lang === 'kotlin')) {
      for (const declared of source.declared) {
        expect(
          source.sent,
          `${source.file} declares "${declared}" and never sends it, so anything ` +
            `waiting on it waits forever`,
        ).toContain(declared);
      }
    }
  });

  for (const site of SITES) {
    it(`${site.file} listens only for events some module declares`, () => {
      for (const event of site.events) {
        expect(
          [...ALL_DECLARED],
          `${site.file} subscribes to "${event}", which no Kotlin module declares. ` +
            `Nothing errors -- the callback simply never fires, which on a phone is ` +
            `indistinguishable from nobody being there.`,
        ).toContain(event);
      }
    });
  }

  it('a cross-platform module declares the same events on both platforms', () => {
    const byModule = new Map<string, NativeSource[]>();
    for (const source of SOURCES) {
      byModule.set(source.module, [...(byModule.get(source.module) ?? []), source]);
    }
    for (const [module, sources] of byModule) {
      if (sources.length < 2) continue;
      const sets = sources.map((s) => [...s.declared].sort());
      for (const other of sets.slice(1)) {
        expect(
          other,
          `${module} declares different events per platform: ` +
            JSON.stringify(sources.map((s) => ({ [s.file]: [...s.declared].sort() }))),
        ).toEqual(sets[0]);
      }
    }
  });
});
