/**
 * Serves the built prototype on the local network.
 *
 * Opening the HTML file directly on a phone means AirDropping it around every
 * time it changes. This serves it instead and prints the LAN URL to type into
 * the phone's browser, so a rebuild is a refresh.
 *
 *   node serve.mjs            # build first, then serve on :8080
 *   PORT=3000 node serve.mjs
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);

/** Rebuild on every request so a phone refresh always shows the latest code. */
function buildHtml() {
  execFileSync('node', [join(here, 'build.mjs')], { stdio: 'ignore' });
  return readFileSync(join(here, 'dist', 'tanks-proto.html'));
}

// Fail loudly at startup rather than serving a 500 to a phone across the room.
buildHtml();

createServer((req, res) => {
  try {
    const html = buildHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // Phones cache aggressively; without this you refresh and see yesterday.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`build failed:\n\n${err.stack || err}`);
  }
}).listen(port, '0.0.0.0', () => {
  const addrs = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log('\n  Tanks! prototype\n');
  console.log(`  local    http://localhost:${port}`);
  for (const a of addrs) console.log(`  phone    http://${a}:${port}`);
  if (!addrs.length) console.log('  (no external network interface found)');
  console.log('\n  Phone must be on the same WiFi. Ctrl-C to stop.\n');
});
