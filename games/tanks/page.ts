/**
 * What the page bundle exports, and so what game.js sees as globals.
 *
 * The tanks engine, plus the lobby's wire protocol, which lives on the
 * platform side in @lan-party/lobby. game.js is only ever a lobby client, so it
 * needs the roster reader and the request writers from there.
 */
export * from './core/src/index.ts';
export * from '@lan-party/lobby';
