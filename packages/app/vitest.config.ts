import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const coreSrc = path.resolve(__dirname, '../core/src');

/**
 * Same two problems Metro has, solved the same way — see metro.config.js.
 *
 *  1. @tanks/core's package.json main points at dist/index.js, but its tsconfig
 *     emits dist/src/index.js, so the declared entry point does not exist.
 *     Resolve to source instead.
 *  2. core is authored as ESM TypeScript, so its own relative imports are
 *     written './math.js' — correct for Node ESM, where the extension names the
 *     built artifact. Map those back onto the .ts source.
 *
 * Scoped to files inside packages/core/src, so a genuine .js import anywhere
 * else still fails loudly rather than being silently rewritten.
 */
const coreSourceResolver = {
  name: 'tanks-core-source-resolver',
  resolveId(source: string, importer: string | undefined) {
    if (!importer || !source.endsWith('.js')) return null;
    if (!importer.startsWith(coreSrc)) return null;
    const asTs = path
      .resolve(path.dirname(importer), source)
      .replace(/\.js$/, '.ts');
    return fs.existsSync(asTs) ? asTs : null;
  },
};

export default defineConfig({
  plugins: [coreSourceResolver],
  resolve: {
    alias: {
      '@tanks/core': path.resolve(coreSrc, 'index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
