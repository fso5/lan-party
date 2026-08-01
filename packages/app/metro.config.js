// Monorepo-aware Metro config.
//
// @tanks/core lives in a sibling workspace package, and npm hoists most deps to
// the repo root. Metro does not follow either of those by default, so we tell it
// explicitly: watch the whole repo, and look in both node_modules trees.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Without this, a package hoisted to the root and also present locally can be
// loaded twice — which breaks React and Reanimated in confusing ways.
config.resolver.disableHierarchicalLookup = true;

// Resolve @tanks/core to source, matching the tsconfig paths entry. Its
// package.json main (dist/index.js) does not match what tsc emits
// (dist/src/index.js), and pointing at source also removes the build step
// between Session A's edits and a Metro reload.
const coreSrc = path.resolve(workspaceRoot, 'packages/core/src');

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@tanks/core': coreSrc,
};

// core is authored as ESM TypeScript, so its own relative imports are written
// as './math.js' — correct for Node ESM, where the extension refers to the
// built output. Metro resolves literally and looks for a math.js that only
// exists after a build, so we map those requests back onto the .ts source.
//
// Scoped to files inside packages/core/src deliberately: a genuine .js import
// anywhere else should still fail loudly rather than be silently rewritten.
const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath ?? '';
  if (moduleName.endsWith('.js') && origin.startsWith(coreSrc)) {
    const asTs = path
      .resolve(path.dirname(origin), moduleName)
      .replace(/\.js$/, '.ts');
    if (fs.existsSync(asTs)) {
      return { type: 'sourceFile', filePath: asTs };
    }
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

module.exports = config;
