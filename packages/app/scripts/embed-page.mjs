/**
 * Embed the game page into the app bundle.
 *
 * The host phone serves this page to everyone else, so it has to travel inside
 * the APK -- there is no internet to fetch it from, which is the whole point.
 *
 * It is embedded as base64 rather than as a string literal. The page is one
 * self-contained file of HTML, CSS and JavaScript, so it is full of quotes,
 * backslashes, backticks and `${`, and every one of those is a way for a
 * generated literal to be subtly wrong. Base64 has no escaping to get wrong,
 * and it decodes through the same tested helper the radio path uses.
 *
 *   node scripts/embed-page.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const protoRoot = resolve(appRoot, '..', 'proto');
const pagePath = join(protoRoot, 'dist', 'tanks-proto.html');
const outPath = join(appRoot, 'src', 'net', 'gamePage.ts');

// Build the page first so this can never embed a stale copy. A host serving
// last week's client against this week's wire protocol fails in a way nobody
// at a picnic table will diagnose.
execFileSync('node', [join(protoRoot, 'build.mjs')], { stdio: 'inherit' });

const html = readFileSync(pagePath);
const b64 = html.toString('base64');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `/**
 * The game page, served by the host phone. GENERATED -- do not edit.
 *
 * Written by scripts/embed-page.mjs from packages/proto/dist/tanks-proto.html.
 * Base64 so that nothing in the page's own quoting can corrupt the literal.
 */

/** ${html.length} bytes of HTML. */
export const GAME_PAGE_BASE64 =
  '${b64}';
`,
);

console.log(`embedded ${html.length} bytes of page -> src/net/gamePage.ts`);
