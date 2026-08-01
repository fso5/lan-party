/**
 * JS surface for the native Bluetooth module.
 *
 * Thin on purpose: this file only converts between the native event shape and
 * the BleAdapter interface that @tanks/core expects. All the protocol logic --
 * framing, fragmentation, reliability choices -- lives in core, where it is
 * testable without a radio.
 */

import { requireNativeModule } from 'expo-modules-core';
import { EventEmitter, type EventSubscription } from 'expo-modules-core';

export interface NativePeer {
  peerId: string;
  name: string;
  rssi?: number;
}

interface TanksBleNative {
  isSupported(): boolean;
  /** Bytes that fit one BLE write, excluding ATT overhead. */
  payloadSize(): number;
  startAdvertising(matchName: string): Promise<void>;
  stopAdvertising(): Promise<void>;
  startScanning(): Promise<void>;
  stopScanning(): Promise<void>;
  connect(peerId: string): Promise<void>;
  disconnect(peerId: string): Promise<void>;
  /** `frame` is base64; postMessage and the native bridge both carry strings. */
  sendFrame(to: string, frame: string, ack: boolean): void;
}

const native = requireNativeModule<TanksBleNative>('TanksBle');
const emitter = new EventEmitter(native as never);

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

  onFrame: (cb: (e: { peerId: string; frame: string }) => void): EventSubscription =>
    emitter.addListener('onFrame', cb),
  onPeerFound: (cb: (e: NativePeer) => void): EventSubscription =>
    emitter.addListener('onPeerFound', cb),
  onPeerConnected: (cb: (e: NativePeer) => void): EventSubscription =>
    emitter.addListener('onPeerConnected', cb),
  onPeerDisconnected: (cb: (e: { peerId: string; reason: string }) => void): EventSubscription =>
    emitter.addListener('onPeerDisconnected', cb),
  onError: (cb: (e: { where: string; message: string }) => void): EventSubscription =>
    emitter.addListener('onError', cb),
  onStateChange: (cb: (e: { state: string; payload?: number; name?: string }) => void): EventSubscription =>
    emitter.addListener('onStateChange', cb),
};
