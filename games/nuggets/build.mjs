/**
 * Bundles the nugget game module, inlining the vendored HTML.
 *
 * The HTML becomes a string constant rather than a file the lobby fetches: a
 * lobby served off someone's phone hotspot should not need a second round trip
 * to start a game, and the vendored file stays byte-identical to upstream so
 * re-vendoring is a copy rather than a merge.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'src', 'game.html'), 'utf8');

await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  outfile: join(here, 'dist', 'index.js'),
  define: { NUGGETS_HTML: JSON.stringify(html) },
  external: ['@lan-party/sdk'],
  logLevel: 'info',
});
