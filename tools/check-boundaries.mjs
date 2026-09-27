/**
 * The platform and the games are separate, and this is what keeps them so.
 *
 *   packages/*   the platform: net, lobby, sdk. Imports nothing from any game.
 *   games/*      one directory per game. May use the platform; may not reach
 *                into another game.
 *
 * A boundary that exists only in a README erodes one convenient import at a
 * time, and nothing goes red when it does -- the code still builds, it just
 * can no longer be pulled apart. So this reads every import in the tree and
 * fails on the first one that crosses the line the wrong way.
 *
 * It also checks that every package directory is listed in the root
 * `workspaces`. That list is explicit rather than a glob because npm builds
 * workspaces in the order they are listed, and a glob put `lobby` ahead of
 * the `net` it depends on. The price of an explicit list is that a new package
 * can be forgotten; this is where that gets caught.
 *
 *   node tools/check-boundaries.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', 'dist-test', '.git']);
const CODE = /\.(ts|js|mjs|cjs)$/;

/** Every workspace package: its directory, its name, and which side it is on. */
function packages() {
  const found = [];
  const visit = (dir) => {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      const rel = relative(ROOT, dir).split(sep).join('/');
      const side = rel.startsWith('packages/') ? 'platform' : 'game';
      // A game is the top-level directory under games/; tanks/core belongs to tanks.
      const game = side === 'game' ? rel.split('/')[1] : null;
      found.push({ dir, rel, name: JSON.parse(readFileSync(pj, 'utf8')).name, side, game });
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP.has(e.name)) visit(join(dir, e.name));
    }
  };
  for (const top of ['packages', 'games']) {
    for (const e of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      if (e.isDirectory()) visit(join(ROOT, top, e.name));
    }
  }
  return found;
}

function codeFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) codeFiles(p, out);
    else if (CODE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Import specifiers: static, dynamic, re-exports and require. */
function specifiers(src) {
  const out = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

const pkgs = packages();
const byName = new Map(pkgs.map((p) => [p.name, p]));
/** The innermost package that contains `file`. */
const owner = (file) =>
  pkgs.filter((p) => file.startsWith(p.dir + sep)).sort((a, b) => b.dir.length - a.dir.length)[0];

const problems = [];

// 1. Every package is a workspace.
const listed = new Set(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).workspaces);
for (const p of pkgs) {
  if (!listed.has(p.rel)) problems.push(`${p.rel} is not in the root package.json workspaces`);
}

// 2. No import crosses the line the wrong way.
function check(fromPkg, file, target) {
  if (!target || target === fromPkg) return;
  const where = relative(ROOT, file);
  if (fromPkg.side === 'platform' && target.side === 'game') {
    problems.push(`${where}: platform code imports ${target.name ?? target.rel}, which is game code`);
  } else if (fromPkg.side === 'game' && target.side === 'game' && fromPkg.game !== target.game) {
    problems.push(`${where}: the ${fromPkg.game} game imports ${target.name ?? target.rel}, from the ${target.game} game`);
  }
}

let scanned = 0;
for (const pkg of pkgs) {
  for (const file of codeFiles(pkg.dir)) {
    if (owner(file) !== pkg) continue; // a nested package scans its own files
    scanned++;
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        check(pkg, file, owner(resolve(dirname(file), spec)));
      } else {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        check(pkg, file, byName.get(name));
      }
    }
  }
  // 3. And no package declares a dependency the imports rule would refuse.
  const pj = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys({ ...pj.dependencies, ...pj.devDependencies })) {
    check(pkg, join(pkg.dir, 'package.json'), byName.get(dep));
  }
}

// A check that looked at nothing passes for the wrong reason.
if (scanned < 20 || !pkgs.some((p) => p.side === 'platform') || !pkgs.some((p) => p.side === 'game')) {
  problems.push(`scanned only ${scanned} files across ${pkgs.length} packages -- this is looking in the wrong place`);
}

if (problems.length) {
  console.error(`Boundary check failed:\n\n  ${problems.join('\n  ')}\n`);
  process.exit(1);
}
console.log(
  `Boundaries hold: ${scanned} files in ${pkgs.length} packages ` +
    `(${pkgs.filter((p) => p.side === 'platform').map((p) => p.name).join(', ')} | ` +
    `${pkgs.filter((p) => p.side === 'game').map((p) => p.name).join(', ')}).`,
);
