/**
 * The transport layer — everything that moves bytes, and nothing that knows
 * what the bytes mean.
 *
 * This is the half of the old `packages/core/net` that is genuinely platform.
 * The split fell in a non-obvious place: `MatchHost` and `MatchClient` look
 * like netcode, but they import the tanks simulation to step worlds and
 * quantise tank positions, so they are *game* code that happens to talk over a
 * wire. They stayed with the game.
 *
 * What lives here imports nothing from any game, which is the property that
 * makes a second game possible.
 */
export * from './transport.js';
export * from './websocket.js';
export * from './lanhost.js';
export * from './bridge.js';
export * from './ble.js';
