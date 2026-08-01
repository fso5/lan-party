/**
 * Builds the prototype into one self-contained HTML file.
 *
 * Everything is inlined -- no external scripts, styles or fonts -- so the
 * result can be opened from disk, served from anywhere, or published as an
 * artifact under a strict CSP that blocks every external host.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const coreEntry = join(here, '..', 'core', 'src', 'index.ts');
const outDir = join(here, 'dist');
const outFile = join(outDir, 'tanks-proto.html');

mkdirSync(outDir, { recursive: true });

// Bundle the core to a single ESM chunk. Its top-level bindings land in the
// same module scope as game.js, which is why game.js can reference them
// directly without an import.
const bundle = execFileSync(
  'npx',
  ['esbuild', coreEntry, '--bundle', '--format=esm', '--target=es2020', '--log-level=warning'],
  { encoding: 'utf8', cwd: here, maxBuffer: 32 * 1024 * 1024 },
);

const game = readFileSync(join(here, 'game.js'), 'utf8');

/**
 * Stamp the build into the page.
 *
 * Without this there is no way to tell which build a phone is actually running
 * -- a cached page, a stale download and the current release all look
 * identical. Reads the commit from CI, falling back to git locally.
 */
function buildId() {
  const sha = process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: here,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'local';
  }
}
const BUILD = buildId();
const template = readFileSync(join(here, 'index.html'), 'utf8');

if (!template.includes('/*__CORE_BUNDLE__*/') || !template.includes('/*__GAME__*/')) {
  throw new Error('index.html is missing its splice markers');
}

// A literal </script> anywhere in the JS would close the inline script tag
// early. Nothing in the source has one today, but a future map name or comment
// easily could, and the failure would look like a blank page.
const guard = (s) => s.replace(/<\/script>/gi, '<\\/script>');

const html = template
  .replace('/*__CORE_BUNDLE__*/', guard(bundle))
  .replace('/*__GAME__*/', guard(game))
  .replace('__BUILD_ID__', BUILD);

writeFileSync(outFile, html);
console.log(`${outFile}  ${(html.length / 1024).toFixed(1)} KB  build ${BUILD}`);
