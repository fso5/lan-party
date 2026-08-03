import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * How big a BLE write the adapter believes it can make.
 *
 * This is the number core fragments against, and getting it too high is the
 * expensive direction: an oversized BLE write is truncated rather than
 * refused, so the frame arrives short and a snapshot loses its tail. A player
 * whose last tank is missing from every other frame is not going to work out
 * that the MTU is the problem, and there is no console on the phone to help.
 *
 * None of this has ever run on a radio. That is the reason to pin the
 * arithmetic here, where it can be checked without one.
 */

const handlers: Record<string, (e: never) => void> = {};

const ble = {
  isSupported: vi.fn(() => true),
  payloadSize: vi.fn(() => 20),
  startAdvertising: vi.fn(async () => {}),
  stopAdvertising: vi.fn(async () => {}),
  startScanning: vi.fn(async () => {}),
  stopScanning: vi.fn(async () => {}),
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendFrame: vi.fn(),
  onFrame: vi.fn(),
  onPeerFound: vi.fn(),
  onPeerConnected: vi.fn(),
  onPeerDisconnected: vi.fn(),
  onError: vi.fn(),
  onStateChange: vi.fn(),
};

vi.mock('../modules/tanks-ble', () => ({ TanksBle: ble }));

// react-native ships Flow-typed source that vitest cannot parse, and the only
// things the adapter takes from it guard the permission prompt -- which none
// of these tests go near.
vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 33 },
  PermissionsAndroid: {
    PERMISSIONS: {
      BLUETOOTH_SCAN: 'scan',
      BLUETOOTH_ADVERTISE: 'advertise',
      BLUETOOTH_CONNECT: 'connect',
      ACCESS_FINE_LOCATION: 'location',
    },
    RESULTS: { GRANTED: 'granted' },
    requestMultiple: async (perms: string[]) =>
      Object.fromEntries(perms.map((p) => [p, 'granted'])),
  },
}));

const { createNativeBleAdapter } = await import('../src/net/bleAdapter');

function reset() {
  vi.clearAllMocks();
  for (const k of Object.keys(handlers)) delete handlers[k];
  for (const name of [
    'onFrame',
    'onPeerFound',
    'onPeerConnected',
    'onPeerDisconnected',
    'onError',
    'onStateChange',
  ] as const) {
    ble[name].mockImplementation((fn: (e: never) => void) => {
      handlers[name] = fn;
      return { remove() {} };
    });
  }
  ble.payloadSize.mockReturnValue(20);
}

const connect = (peerId: string) =>
  handlers.onPeerConnected({ peerId, name: peerId } as never);
const disconnect = (peerId: string) =>
  handlers.onPeerDisconnected({ peerId, reason: 'gone' } as never);
const mtu = (payload: number) =>
  handlers.onStateChange({ state: 'mtu', payload } as never);

beforeEach(reset);

describe('payload size', () => {
  test('starts conservative, before any radio has said anything', () => {
    // 20 is the number every BLE stack must accept. Two of it go to core's
    // fragment header.
    expect(createNativeBleAdapter().payloadSize).toBe(18);
  });

  test('grows to what a single connected phone negotiated', () => {
    const a = createNativeBleAdapter();
    ble.payloadSize.mockReturnValue(185);
    connect('p1');
    expect(a.payloadSize).toBe(183);
  });

  test('follows a late MTU negotiation downwards', () => {
    const a = createNativeBleAdapter();
    ble.payloadSize.mockReturnValue(185);
    connect('p1');
    mtu(64);
    expect(a.payloadSize).toBe(62);
  });

  test('never drops below the floor, whatever the radio claims', () => {
    const a = createNativeBleAdapter();
    connect('p1');
    mtu(3);
    expect(a.payloadSize).toBe(18);
  });

  test('backs off to the floor once a second phone joins', () => {
    // Neither MTU signal names a peer, so with two links there is no way to
    // tell whose number just arrived. Keeping the larger -- which is what this
    // used to do -- writes past what the smaller link can carry, and BLE
    // truncates rather than refusing.
    const a = createNativeBleAdapter();
    ble.payloadSize.mockReturnValue(185);
    connect('p1');
    expect(a.payloadSize).toBe(183);

    ble.payloadSize.mockReturnValue(23);
    connect('p2');
    expect(a.payloadSize).toBe(18);
  });

  test('a big MTU arriving while two phones are connected is not believed', () => {
    const a = createNativeBleAdapter();
    connect('p1');
    connect('p2');
    mtu(247);
    expect(a.payloadSize).toBe(18);
  });

  test('stays at the floor after one of two leaves, until that link speaks', () => {
    // We know one peer is left. We do not know which, so its MTU is still
    // unknown and guessing it is the one mistake that corrupts data.
    const a = createNativeBleAdapter();
    ble.payloadSize.mockReturnValue(185);
    connect('p1');
    connect('p2');
    disconnect('p2');
    expect(a.payloadSize).toBe(18);

    mtu(185);
    expect(a.payloadSize).toBe(183);
  });
});

describe('frames', () => {
  test('reach the radio as base64 and come back as bytes', () => {
    const a = createNativeBleAdapter();
    const seen: [string, Uint8Array][] = [];
    a.onFrame((from, frame) => seen.push([from, frame]));

    const payload = Uint8Array.from([0, 1, 127, 128, 255, 7]);
    a.sendFrame('p1', payload, true);
    const encoded = ble.sendFrame.mock.calls[0][1];
    expect(typeof encoded).toBe('string');

    handlers.onFrame({ peerId: 'p1', frame: encoded } as never);
    expect(seen[0][0]).toBe('p1');
    expect(Array.from(seen[0][1])).toEqual(Array.from(payload));
  });
});
