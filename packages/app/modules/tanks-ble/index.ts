/**
 * JS surface for the native Bluetooth module.
 *
 * Thin on purpose: this only names what the native side exposes and types its
 * events. All the protocol logic -- framing, fragmentation, reliability
 * choices -- lives in @tanks/core, where it is testable without a radio.
 */

import { NativeModule, requireNativeModule, type EventSubscription } from 'expo-modules-core';

export interface NativePeer {
  peerId: string;
  name: string;
  rssi?: number;
}

/**
 * Events the native side emits.
 *
 * Declared as a map on NativeModule rather than wired through a standalone
 * EventEmitter, so listener names and payloads are checked at compile time. A
 * renamed event would otherwise fail silently at runtime -- and on a radio path
 * "no events arriving" is very hard to tell apart from "the other phone isn't
 * there", which is the worst kind of bug to go looking for.
 */
type TanksBleEvents = {
  onFrame: (event: { peerId: string; frame: string }) => void;
  onPeerFound: (event: NativePeer) => void;
  onPeerConnected: (event: NativePeer) => void;
  onPeerDisconnected: (event: { peerId: string; reason: string }) => void;
  onError: (event: { where: string; message: string }) => void;
  onStateChange: (event: { state: string; payload?: number; name?: string }) => void;
};

declare class TanksBleNativeModule extends NativeModule<TanksBleEvents> {
  isSupported(): boolean;
  /** Bytes that fit one BLE write, excluding ATT overhead. */
  payloadSize(): number;
  startAdvertising(matchName: string): Promise<void>;
  stopAdvertising(): Promise<void>;
  startScanning(): Promise<void>;
  stopScanning(): Promise<void>;
  connect(peerId: string): Promise<void>;
  disconnect(peerId: string): Promise<void>;
  /** `frame` is base64 -- the native bridge carries strings, not byte arrays. */
  sendFrame(to: string, frame: string, ack: boolean): void;
}

const native = requireNativeModule<TanksBleNativeModule>('TanksBle');

export const TanksBle = {
  isSupported: () => native.isSupported(),
  payloadSize: () => native.payloadSize(),
  startAdvertising: (matchName: string) => native.startAdvertising(matchName),
  stopAdvertising: () => native.stopAdvertising(),
  startScanning: () => native.startScanning(),
  stopScanning: () => native.stopScanning(),
  connect: (peerId: string) => native.connect(peerId),
  disconnect: (peerId: string) => native.disconnect(peerId),
  sendFrame: (to: string, frameBase64: string, ack: boolean) =>
    native.sendFrame(to, frameBase64, ack),

  onFrame: (cb: TanksBleEvents['onFrame']): EventSubscription => native.addListener('onFrame', cb),
  onPeerFound: (cb: TanksBleEvents['onPeerFound']): EventSubscription =>
    native.addListener('onPeerFound', cb),
  onPeerConnected: (cb: TanksBleEvents['onPeerConnected']): EventSubscription =>
    native.addListener('onPeerConnected', cb),
  onPeerDisconnected: (cb: TanksBleEvents['onPeerDisconnected']): EventSubscription =>
    native.addListener('onPeerDisconnected', cb),
  onError: (cb: TanksBleEvents['onError']): EventSubscription => native.addListener('onError', cb),
  onStateChange: (cb: TanksBleEvents['onStateChange']): EventSubscription =>
    native.addListener('onStateChange', cb),
};
