/**
 * JS surface for the native TCP listener.
 *
 * As thin as it can be. A JavaScript runtime on Android cannot bind a port, so
 * this names the four operations that need to cross into Kotlin -- accept,
 * read, write, close -- and nothing else. The HTTP handshake, WebSocket framing
 * and the match all live in @tanks/core, under test in Node.
 *
 * Android only. iOS is not a host: iPhones join a match by opening a URL in
 * Safari, which is the entire reason this route exists.
 */

import { NativeModule, requireNativeModule } from 'expo-modules-core';

/**
 * Events the native side emits.
 *
 * Typed as a map on NativeModule rather than a loose emitter, so a renamed
 * event is a compile error. On a network path "no events arriving" is
 * indistinguishable from "nobody has joined yet", which is a miserable thing to
 * debug at a picnic table.
 */
type TanksLanEvents = {
  onConnection: (event: { connId: string }) => void;
  /** `data` is base64 -- the native bridge carries strings, not byte arrays. */
  onData: (event: { connId: string; data: string }) => void;
  onClose: (event: { connId: string }) => void;
  onError: (event: { where: string; message: string }) => void;
};

declare class TanksLanNativeModule extends NativeModule<TanksLanEvents> {
  isSupported(): boolean;
  /** Begin listening. Resolves with the port actually bound. */
  start(port: number): Promise<number>;
  stop(): Promise<void>;
  send(connId: string, dataBase64: string): void;
  close(connId: string): void;
  /** This device's IPv4 on the local network, for building the join URL. */
  getIpAddress(): string | null;
}

/**
 * Null when the native module is absent -- on iOS, or in a plain Expo Go
 * build. Callers must treat "no radio here" as an ordinary state and offer a
 * different route, rather than crashing on import.
 */
export const TanksLanNative: TanksLanNativeModule | null = (() => {
  try {
    return requireNativeModule<TanksLanNativeModule>('TanksLan');
  } catch {
    return null;
  }
})();

export const canHostOverWifi = (): boolean => TanksLanNative !== null;
