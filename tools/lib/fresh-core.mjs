/**
 * Refuse to measure a stale build.
 *
 * Every tool in here imports `@tanks/core`, whose package main is
 * `dist/index.js`. So they measure the last *compiled* core, not the source
 * sitting on disk -- and nothing says so at the point of use.
 *
 * That is not a theoretical hazard. Comparing an AI change against main by
 * editing `src`, running tank-balance, reverting `src`, and running it again
 * produced two identical tables. Both came from the same stale `dist`, and the
 * obvious reading of identical numbers is "the change has no effect on
 * balance" -- a wrong answer with nothing about it to doubt. The real tables
 * differed once each variant was actually built.
 *
 * A warning printed above a table of numbers would be scrolled past, so this
 * refuses instead. A missing measurement is recoverable; a confident wrong one
 * is what gets written down.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Newest mtime anywhere under `dir`, or null if there is no such directory. */
function newestMtime(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = 0;
  for (const e of entries) {
    const p = join(dir, e.name);
    const t = e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs;
    if (t !== null && t > newest) newest = t;
  }
  return newest;
}

/**
 * Call once, before importing anything that reads the core's behaviour.
 *
 * `root` is the repository root; the caller passes it because these tools are
 * run from wherever the author happens to be standing.
 */
export function requireFreshCore(root) {
  const src = newestMtime(join(root, 'packages/core/src'));
  const dist = newestMtime(join(root, 'packages/core/dist'));

  if (src === null) return; // not a checkout we understand; do not get in the way

  // A dist that is missing outright never reaches here -- ESM resolves the
  // caller's `@tanks/core` import before any of this runs, and fails with
  // ERR_MODULE_NOT_FOUND. That is loud and accurate, so it needs no help. What
  // this catches is the quiet case: a dist that exists and is out of date.
  if (dist === null || dist < src) {
    process.stderr.write(
      '\n  packages/core/dist is older than packages/core/src, ' +
        'and these tools measure dist.\n' +
        '  Refusing to print numbers that describe code you are no longer running.\n\n' +
        '      npm run build -w @tanks/core\n\n' +
        '  Do this between variants too, not just once: an A/B run that skips the\n' +
        '  rebuild compares a change against itself and reports no difference.\n\n',
    );
    process.exit(1);
  }
}
