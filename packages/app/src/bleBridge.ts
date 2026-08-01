/**
 * Wires the native radio to the game running in the WebView.
 *
 * The game owns the simulation, the netcode and the renderer; native owns the
 * radio. This is the join between them, and it is deliberately dumb: it moves
 * frames and connection events across, and makes no decisions. Every choice
 * that matters -- what is reliable, how messages are framed, when to
 * reconcile -- lives in @tanks/core where it is tested without hardware.
 *
 * Frames cross as base64 because postMessage carries strings. That is 33%
 * overhead on a few hundred bytes a second, which is not worth a cleverer
 * scheme when the radio itself costs 45ms.
 */

import { PermissionsAndroid, Platform } from 'react-native';

import { TanksBle } from '../modules/tanks-ble';

export type ToWeb = (event: Record<string, unknown>) => void;

/**
 * Ask for what the radio needs.
 *
 * Android 12 split the old blanket Bluetooth permission into three, and
 * scanning additionally needed location before that. Getting this wrong does
 * not throw -- the scan simply returns nothing forever, which is a miserable
 * thing to debug, so we check the results rather than fire and forget.
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

export interface BleBridgeHandle {
  handleMessage(msg: { type: string; [k: string]: unknown }): void;
  dispose(): void;
}

/**
 * Start listening to the radio and forwarding into the page.
 *
 * Returns a handle whose handleMessage takes the page's outbound requests.
 */
export function createBleBridge(toWeb: ToWeb): BleBridgeHandle {
  const subs = [
    TanksBle.onFrame((e) => toWeb({ type: 'ble.frame', from: e.peerId, frame: e.frame })),
    TanksBle.onPeerFound((e) =>
      toWeb({ type: 'ble.found', peerId: e.peerId, name: e.name, rssi: e.rssi }),
    ),
    TanksBle.onPeerConnected((e) =>
      toWeb({ type: 'ble.connected', peerId: e.peerId, name: e.name }),
    ),
    TanksBle.onPeerDisconnected((e) =>
      toWeb({ type: 'ble.disconnected', peerId: e.peerId, reason: e.reason }),
    ),
    TanksBle.onError((e) => toWeb({ type: 'ble.error', where: e.where, message: e.message })),
    TanksBle.onStateChange((e) =>
      toWeb({ type: 'ble.state', state: e.state, payload: e.payload, name: e.name }),
    ),
  ];

  const handle: BleBridgeHandle = {
    handleMessage(msg) {
      switch (msg.type) {
        case 'ble.host':
          void (async () => {
            const perms = await requestBlePermissions();
            if (!perms.ok) {
              toWeb({
                type: 'ble.error',
                where: 'permission',
                message: `denied: ${perms.missing.join(', ')}`,
              });
              return;
            }
            if (!TanksBle.isSupported()) {
              toWeb({
                type: 'ble.error',
                where: 'support',
                message: 'Bluetooth is off, or this device cannot host',
              });
              return;
            }
            await TanksBle.startAdvertising(String(msg.matchName ?? 'Tanks'));
            toWeb({ type: 'ble.ready', role: 'host', payload: TanksBle.payloadSize() });
          })();
          break;

        case 'ble.discover':
          void (async () => {
            const perms = await requestBlePermissions();
            if (!perms.ok) {
              toWeb({
                type: 'ble.error',
                where: 'permission',
                message: `denied: ${perms.missing.join(', ')}`,
              });
              return;
            }
            await TanksBle.startScanning();
            toWeb({ type: 'ble.ready', role: 'client', payload: TanksBle.payloadSize() });
          })();
          break;

        case 'ble.connect':
          void TanksBle.stopScanning().then(() => TanksBle.connect(String(msg.peerId)));
          break;

        case 'ble.stop':
          void TanksBle.stopScanning();
          void TanksBle.stopAdvertising();
          break;

        case 'ble.send':
          // Synchronous and unawaited: this is on the per-tick hot path, and a
          // promise per frame at 60Hz would add scheduling latency to the one
          // thing that cannot afford it.
          TanksBle.sendFrame(String(msg.to), String(msg.frame), Boolean(msg.ack));
          break;
      }
    },

    dispose() {
      for (const s of subs) s.remove();
      void TanksBle.stopScanning();
      void TanksBle.stopAdvertising();
    },
  };

  return handle;
}
