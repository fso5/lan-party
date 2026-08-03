/**
 * BleAdapter backed by the native radio.
 *
 * `@tanks/core` defines `BleAdapter` as an interface precisely so that core
 * never imports a native module and keeps running in Node tests and a browser.
 * This is the implementation of that seam on a device: it translates between
 * core's byte frames and the native module's base64 strings, and does nothing
 * else. Framing, fragmentation, the reliable/unreliable choice and every
 * netcode decision stay in core, where they are tested against a simulated link
 * with no hardware involved.
 *
 * This got considerably simpler when the app moved to a native renderer. The
 * WebView build had to hop every frame across postMessage; now the sim, the
 * transport and the radio are all in one JS context and the adapter is a thin
 * translation layer.
 */

import { PermissionsAndroid, Platform } from 'react-native';
import type { BleAdapter, Peer, PeerId } from '@tanks/core';

import { TanksBle } from '../../modules/tanks-ble';
import { base64ToBytes, bytesToBase64 } from './base64';

export interface RadioError {
  where: string;
  message: string;
}

/**
 * Ask for what the radio needs.
 *
 * Android 12 split the blanket Bluetooth permission into three, and before that
 * scanning needed location. Getting this wrong does not throw -- the scan simply
 * returns nothing, forever, which is a miserable thing to debug. So the results
 * are checked rather than fired and forgotten.
 */
export async function requestBlePermissions(): Promise<{ ok: boolean; missing: string[] }> {
  if (Platform.OS !== 'android') {
    // iOS prompts on first CoreBluetooth use, driven by the usage strings in
    // app.json. Nothing to request up front.
    return { ok: true, missing: [] };
  }

  const api = Platform.Version as number;
  const needed =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const granted = await PermissionsAndroid.requestMultiple(needed);
  const missing = needed.filter((p) => granted[p] !== PermissionsAndroid.RESULTS.GRANTED);
  return { ok: missing.length === 0, missing };
}

export interface NativeBleAdapterHandle extends BleAdapter {
  /** Stop listening. Safe to call twice. */
  dispose(): void;
  /** Surfaced so the UI can show why a radio operation failed. */
  onError(cb: (err: RadioError) => void): void;
}

export function createNativeBleAdapter(): NativeBleAdapterHandle {
  let frameCb: ((from: PeerId, frame: Uint8Array) => void) | null = null;
  let connectedCb: ((peer: Peer) => void) | null = null;
  let disconnectedCb: ((peerId: PeerId, reason: string) => void) | null = null;
  let foundCb: ((peer: Peer) => void) | null = null;
  let errorCb: ((err: RadioError) => void) | null = null;

  /**
   * Conservative until the link says otherwise.
   *
   * An oversized BLE write is silently truncated rather than rejected, which
   * would corrupt a snapshot instead of dropping it -- so this may only ever
   * grow on hard evidence from a negotiated MTU, never optimistically.
   */
  const FLOOR = 20;
  let payload = FLOOR;

  /**
   * Who is connected right now, because neither MTU signal names a peer.
   *
   * `payloadSize()` takes no argument and the mtu state change carries no peer
   * id, so both describe "the link" and there is only one link to describe
   * while a single phone is connected. With two, there is no way to tell whose
   * MTU just arrived -- and taking the larger of them, which is what this used
   * to do, hands the phone with the smaller one writes it cannot carry. BLE
   * truncates an oversized write instead of refusing it, so that is a snapshot
   * quietly losing its last tank rather than a packet that never came.
   *
   * So: one peer, believe what the radio says; more than one, back off to the
   * floor and fragment. Slower, and it cannot corrupt anything. Doing better
   * needs the native side to report an MTU per connection, which is a change
   * to make when there is a radio to check it against.
   */
  const live = new Set<PeerId>();

  const trustRadio = (reported: number) => {
    // No lower bound here on purpose: `payloadSize` already refuses to go
    // below 18, and a second floor in this line cannot be told apart from the
    // first by any test.
    payload = live.size > 1 ? FLOOR : reported;
  };

  const subs = [
    TanksBle.onFrame((e) => frameCb?.(e.peerId, base64ToBytes(e.frame))),
    TanksBle.onPeerFound((e) => foundCb?.({ id: e.peerId, name: e.name, rtt: -1 })),
    TanksBle.onPeerConnected((e) => {
      live.add(e.peerId);
      trustRadio(TanksBle.payloadSize());
      connectedCb?.({ id: e.peerId, name: e.name, rtt: -1 });
    }),
    TanksBle.onPeerDisconnected((e) => {
      // Nothing to reset. Two peers means the payload is already at the floor,
      // and dropping to one does not tell us which one is left or what it
      // negotiated -- so it stays there until that link says otherwise.
      live.delete(e.peerId);
      disconnectedCb?.(e.peerId, e.reason);
    }),
    TanksBle.onError((e) => errorCb?.({ where: e.where, message: e.message })),
    TanksBle.onStateChange((e) => {
      // A late MTU negotiation can shrink what one write carries; shrink with it.
      if (e.state === 'mtu' && typeof e.payload === 'number') trustRadio(e.payload);
    }),
  ];

  return {
    get payloadSize() {
      // Leave room for core's 2-byte fragment header.
      return Math.max(18, payload - 2);
    },

    async startAdvertising(matchName: string) {
      const perms = await requestBlePermissions();
      if (!perms.ok) {
        errorCb?.({ where: 'permission', message: `denied: ${perms.missing.join(', ')}` });
        return;
      }
      if (!TanksBle.isSupported()) {
        errorCb?.({ where: 'support', message: 'Bluetooth is off, or this device cannot host' });
        return;
      }
      await TanksBle.startAdvertising(matchName);
    },

    stopAdvertising: () => TanksBle.stopAdvertising(),

    async startScanning(onFound: (peer: Peer) => void) {
      foundCb = onFound;
      const perms = await requestBlePermissions();
      if (!perms.ok) {
        errorCb?.({ where: 'permission', message: `denied: ${perms.missing.join(', ')}` });
        return;
      }
      await TanksBle.startScanning();
    },

    stopScanning: () => TanksBle.stopScanning(),
    connect: (peerId: PeerId) => TanksBle.connect(peerId),
    disconnect: (peerId: PeerId) => TanksBle.disconnect(peerId),

    // Synchronous and unawaited: this is the per-tick hot path, and a promise
    // per frame at 60Hz would add scheduling latency to the one thing that
    // cannot afford it.
    sendFrame: (to: PeerId, frame: Uint8Array, ack: boolean) =>
      TanksBle.sendFrame(to, bytesToBase64(frame), ack),

    onFrame: (cb) => {
      frameCb = cb;
    },
    onPeerConnected: (cb) => {
      connectedCb = cb;
    },
    onPeerDisconnected: (cb) => {
      disconnectedCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    },

    dispose() {
      for (const s of subs) s.remove();
      void TanksBle.stopScanning();
      void TanksBle.stopAdvertising();
    },
  };
}
