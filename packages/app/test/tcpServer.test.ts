import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The translation layer between the native Android listener and core.
 *
 * There is no decision-making here worth testing -- that is all in core, on
 * purpose. What there is instead is lifecycle, and lifecycle is exactly what
 * cannot be checked without either a phone or this. Every player who joins
 * over WiFi arrives through these four listeners, and the failure modes are
 * quiet ones: a subscription that outlives its socket delivers every packet
 * twice, and one that was never attached loses a player who is connected and
 * invisible.
 */

const native = {
  getIpAddress: vi.fn<() => string | null>(),
  getIpCandidates: vi.fn<() => { name: string; address: string }[]>() as unknown as
    | (() => { name: string; address: string }[])
    | undefined,
  start: vi.fn<(port: number) => Promise<number>>(),
  stop: vi.fn<() => Promise<void>>(),
  send: vi.fn<(connId: string, data: string) => void>(),
  close: vi.fn<(connId: string) => void>(),
  addListener: vi.fn(),
};

/** Every listener handed to the native module, and whether it is still live. */
let subs: { event: string; fn: (payload: never) => void; removed: boolean }[] = [];

vi.mock('../modules/tanks-lan', () => ({
  get TanksLanNative() {
    return native;
  },
  canHostOverWifi: () => true,
}));

const { NativeTcpServer } = await import('../src/net/tcpServer');

function reset() {
  subs = [];
  vi.clearAllMocks();
  native.addListener.mockImplementation((event: string, fn: (payload: never) => void) => {
    const sub = { event, fn, removed: false };
    subs.push(sub);
    return {
      remove() {
        sub.removed = true;
      },
    };
  });
  native.start.mockResolvedValue(8080);
  native.stop.mockResolvedValue(undefined);
  native.getIpAddress.mockReturnValue('10.0.0.5');
  (native as { getIpCandidates?: unknown }).getIpCandidates = vi
    .fn()
    .mockReturnValue([{ name: 'ap0', address: '192.168.43.1' }]);
}

const live = () => subs.filter((s) => !s.removed);

beforeEach(reset);

describe('the address the host reads out', () => {
  test('comes from the candidate list, chosen by core', () => {
    // Two addresses, and the reachable one is not the first. Picking wrongly
    // produces a URL that fails for everyone in the room, in a way that looks
    // exactly like a hotspot isolating its clients.
    (native as { getIpCandidates: unknown }).getIpCandidates = vi.fn().mockReturnValue([
      { name: 'rmnet_data0', address: '10.132.44.9' },
      { name: 'ap0', address: '192.168.43.1' },
    ]);
    expect(new NativeTcpServer().getIpAddress()).toBe('192.168.43.1');
  });

  test('falls back to the single-address call on an older native build', () => {
    // The APK on the phone can be older than the JavaScript in it, because the
    // web page is served from the host and the app is not reinstalled.
    delete (native as { getIpCandidates?: unknown }).getIpCandidates;
    expect(new NativeTcpServer().getIpAddress()).toBe('10.0.0.5');
  });

  test('falls back when the candidate call exists but throws', () => {
    (native as { getIpCandidates: unknown }).getIpCandidates = vi.fn(() => {
      throw new Error('no such method');
    });
    expect(new NativeTcpServer().getIpAddress()).toBe('10.0.0.5');
  });

  test('falls back when the phone reports no candidates at all', () => {
    (native as { getIpCandidates: unknown }).getIpCandidates = vi.fn().mockReturnValue([]);
    expect(new NativeTcpServer().getIpAddress()).toBe('10.0.0.5');
  });

  test('reports nothing rather than guessing when there is no address', () => {
    (native as { getIpCandidates: unknown }).getIpCandidates = vi.fn().mockReturnValue([]);
    native.getIpAddress.mockReturnValue(null);
    expect(new NativeTcpServer().getIpAddress()).toBeNull();
  });
});

describe('listener lifecycle', () => {
  test('subscribes before the socket is listening', async () => {
    // A phone can connect between bind and subscribe, and that connection
    // would arrive with nobody listening for it.
    let subsAtStart = -1;
    native.start.mockImplementation(async () => {
      subsAtStart = live().length;
      return 8080;
    });

    await new NativeTcpServer().start(8080);
    expect(subsAtStart).toBe(4);
  });

  test('lets go of its listeners when the socket fails to bind', async () => {
    // The port-fallback path in LanHost retries after a failed bind. Leaving
    // the first attempt's listeners attached would deliver every later packet
    // twice, which reads as a client firing twice per trigger pull.
    native.start.mockRejectedValue(new Error('EADDRINUSE'));

    const server = new NativeTcpServer();
    await expect(server.start(8080)).rejects.toThrow('EADDRINUSE');
    expect(live()).toHaveLength(0);
  });

  test('lets go of its listeners when it is stopped', async () => {
    const server = new NativeTcpServer();
    await server.start(8080);
    expect(live()).toHaveLength(4);

    await server.stop();
    expect(live()).toHaveLength(0);
  });

  test('a second start does not leave the first start’s listeners attached', async () => {
    // Two live sets of listeners means every packet is handed to core twice:
    // each input applied twice, each spawn deduped or doubled. Reachable by
    // tapping "Start hosting" twice, or by a screen that remounts.
    const server = new NativeTcpServer();
    await server.start(8080);
    await server.start(8080);

    expect(live()).toHaveLength(4);
  });
});

describe('translation', () => {
  test('bytes reach the native side as base64 and come back as bytes', async () => {
    const server = new NativeTcpServer();
    const seen: Uint8Array[] = [];
    server.setHandlers({
      onConnection: () => {},
      onData: (_id, data) => seen.push(data),
      onClose: () => {},
      onError: () => {},
    });
    await server.start(8080);

    const payload = Uint8Array.from([0, 1, 127, 128, 255, 42]);
    server.send('c1', payload);
    const sent = native.send.mock.calls[0][1];
    expect(typeof sent).toBe('string');

    // Feed the host's own encoding back through the inbound path.
    subs.find((s) => s.event === 'onData')!.fn({ connId: 'c1', data: sent } as never);
    expect(Array.from(seen[0])).toEqual(Array.from(payload));
  });
});
