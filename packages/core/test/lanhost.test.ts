/**
 * Hosting over WiFi.
 *
 * Two layers of test here, on purpose.
 *
 * The first drives `LanHost` through a fake socket, which makes the awkward
 * cases reachable: a request head split across reads, a client's first frame
 * arriving glued to its handshake, a corrupt frame from one player.
 *
 * The second runs the whole thing over a real TCP socket with a real WebSocket
 * client on the far end, playing an actual match through `MatchHost` and
 * `MatchClient`. That is as close to two phones as this can get without two
 * phones, and it is the test that would catch a mistake the fake and I happen
 * to agree about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_LAN_PORT,
  LanHost,
  type TcpConnectionHandlers,
  type TcpServer,
} from '../src/net/lanhost.js';
import { WsOpcode } from '../src/net/websocket.js';
import { BridgeTransport } from '../src/net/bridge.js';
import { MatchHost } from '../src/net/host.js';
import { MatchClient } from '../src/net/client.js';
import { createWorld, cloneWorld } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';

const PAGE = new TextEncoder().encode('<!doctype html><title>Tanks!</title>');

/** A TcpServer that records what was written, with no sockets involved. */
class FakeTcp implements TcpServer {
  handlers!: TcpConnectionHandlers;
  sent = new Map<string, Uint8Array[]>();
  closed: string[] = [];
  ip: string | null = '192.168.43.1';
  boundPort = 0;

  async start(port: number) {
    this.boundPort = port;
    return port;
  }
  async stop() {}
  send(connId: string, data: Uint8Array) {
    const list = this.sent.get(connId) ?? [];
    list.push(data);
    this.sent.set(connId, list);
  }
  close(connId: string) {
    this.closed.push(connId);
  }
  setHandlers(h: TcpConnectionHandlers) {
    this.handlers = h;
  }
  getIpAddress() {
    return this.ip;
  }

  text(connId: string): string {
    return (this.sent.get(connId) ?? [])
      .map((b) => new TextDecoder('latin1').decode(b))
      .join('');
  }
  feed(connId: string, s: string | Uint8Array) {
    const bytes = typeof s === 'string' ? Uint8Array.from([...s].map((c) => c.charCodeAt(0))) : s;
    this.handlers.onData(connId, bytes);
  }
}

function upgradeRequest(): string {
  return (
    'GET / HTTP/1.1\r\n' +
    'Host: 192.168.43.1:8080\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );
}

/** A masked client frame, the way a browser sends one. */
function clientFrame(payload: Uint8Array, opcode = WsOpcode.Binary): Uint8Array {
  const mask = Uint8Array.from([0x21, 0x09, 0x77, 0x4b]);
  const out = new Uint8Array(2 + 4 + payload.length);
  out[0] = 0x80 | opcode;
  out[1] = 0x80 | payload.length;
  out.set(mask, 2);
  for (let i = 0; i < payload.length; i++) out[6 + i] = payload[i] ^ mask[i & 3];
  return out;
}

async function makeHost(tcp: FakeTcp) {
  const host = new LanHost(tcp, { page: PAGE });
  await host.start();
  return host;
}

test('a plain browser request gets the game page and the connection closes', async () => {
  const tcp = new FakeTcp();
  await makeHost(tcp);

  tcp.handlers.onConnection('c1');
  tcp.feed('c1', 'GET / HTTP/1.1\r\nHost: x\r\n\r\n');

  const out = tcp.text('c1');
  assert.match(out, /^HTTP\/1\.1 200 OK/);
  assert.match(out, /Content-Type: text\/html/);
  assert.match(out, /<title>Tanks!<\/title>/);
  // The page opens its own socket, so this one has no further purpose.
  assert.deepEqual(tcp.closed, ['c1']);
});

test('a request head split across reads is still understood', async () => {
  // TCP has no respect for message boundaries. A head parsed only when it
  // arrives whole works on a desktop and fails on a phone hotspot.
  const tcp = new FakeTcp();
  await makeHost(tcp);
  tcp.handlers.onConnection('c1');

  const req = upgradeRequest();
  for (const ch of req) tcp.feed('c1', ch);

  assert.match(tcp.text('c1'), /101 Switching Protocols/);
  assert.match(tcp.text('c1'), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
});

test('a first frame glued to the handshake is not lost', async () => {
  // The client's first packet routinely arrives in the same read as its
  // handshake, and that packet is the join. A host that discards whatever
  // followed the blank line drops players for no visible reason.
  const tcp = new FakeTcp();
  const host = await makeHost(tcp);

  const received: Uint8Array[] = [];
  host.transport.setEvents({ onPacket: (_from, data) => received.push(data) });

  tcp.handlers.onConnection('c1');
  const payload = Uint8Array.from([7, 7, 7]);
  const frame = clientFrame(payload);
  const req = upgradeRequest();
  const glued = new Uint8Array(req.length + frame.length);
  glued.set(Uint8Array.from([...req].map((c) => c.charCodeAt(0))));
  glued.set(frame, req.length);

  tcp.handlers.onData('c1', glued);

  assert.equal(received.length, 1, 'the frame riding with the handshake must arrive');
  assert.deepEqual(received[0], payload);
});

test('an upgraded connection becomes a peer, and leaving removes it', async () => {
  const tcp = new FakeTcp();
  const host = await makeHost(tcp);

  const joined: string[] = [];
  const left: string[] = [];
  host.onPlayerJoin = (p) => joined.push(p.id);
  host.onPlayerLeave = (id) => left.push(id);

  tcp.handlers.onConnection('c1');
  tcp.feed('c1', upgradeRequest());
  assert.deepEqual(joined, ['c1']);
  assert.deepEqual(host.playerIds, ['c1']);

  tcp.handlers.onClose('c1');
  assert.deepEqual(left, ['c1']);
  assert.deepEqual(host.playerIds, [], 'a departed phone must not keep its slot');
});

test('a browser that only fetched the page never counts as a player', async () => {
  const tcp = new FakeTcp();
  const host = await makeHost(tcp);
  const left: string[] = [];
  host.onPlayerLeave = (id) => left.push(id);

  tcp.handlers.onConnection('c1');
  tcp.feed('c1', 'GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  tcp.handlers.onClose('c1');

  assert.deepEqual(left, [], 'serving a page is not a player joining or leaving');
});

test('one corrupt frame drops that player and nobody else', async () => {
  // Everyone else is mid-match. A framing error must cost one connection, not
  // the host.
  const tcp = new FakeTcp();
  const host = await makeHost(tcp);
  const errors: string[] = [];
  host.onError = (where) => errors.push(where);

  for (const id of ['c1', 'c2']) {
    tcp.handlers.onConnection(id);
    tcp.feed(id, upgradeRequest());
  }
  assert.equal(host.playerIds.length, 2);

  // Unmasked: illegal from a client, so the decoder rejects it.
  tcp.handlers.onData('c1', Uint8Array.from([0x82, 0x02, 0xaa, 0xbb]));

  assert.deepEqual(errors, ['frame']);
  assert.ok(tcp.closed.includes('c1'));
  assert.deepEqual(host.playerIds, ['c2'], 'the other player keeps playing');
});

test('an endless request head is cut off rather than buffered forever', async () => {
  const tcp = new FakeTcp();
  const host = await makeHost(tcp);
  const errors: string[] = [];
  host.onError = (where) => errors.push(where);

  tcp.handlers.onConnection('c1');
  // Never sends the blank line that ends a head.
  for (let i = 0; i < 40; i++) tcp.feed('c1', `X-Pad-${i}: ${'a'.repeat(512)}\r\n`);

  assert.deepEqual(errors, ['http']);
  assert.ok(tcp.closed.includes('c1'));
});

test('the join URL is built from the device address, and absent without one', async () => {
  const tcp = new FakeTcp();
  const host = await makeHost(tcp);
  assert.equal(host.joinUrl, `http://192.168.43.1:${DEFAULT_LAN_PORT}`);

  tcp.ip = null;
  assert.equal(host.joinUrl, null, 'no address means no URL to read out, not a broken one');
});

test('sending to a peer that already left is not an error', async () => {
  // Packets are queued a tick before they go out and phones leave mid-tick, so
  // this is an ordinary race, not a fault.
  const tcp = new FakeTcp();
  const host = await makeHost(tcp);
  tcp.handlers.onConnection('c1');
  tcp.feed('c1', upgradeRequest());

  const errors: string[] = [];
  host.onError = (where) => errors.push(where);
  tcp.handlers.onClose('c1');
  host.transport.send('c1', Uint8Array.from([1, 2, 3]), false);

  assert.deepEqual(errors, []);
});

/* ---------------------------------------------------------------------------
 * End to end, over a real socket.
 * ------------------------------------------------------------------------ */

/** TcpServer backed by node:net -- what the Kotlin module does natively. */
class NodeTcp implements TcpServer {
  private server: Server | null = null;
  private socks = new Map<string, Socket>();
  private handlers!: TcpConnectionHandlers;
  private next = 1;

  setHandlers(h: TcpConnectionHandlers) {
    this.handlers = h;
  }
  getIpAddress() {
    return '127.0.0.1';
  }

  async start(port: number): Promise<number> {
    this.server = createServer((sock) => {
      const id = `c${this.next++}`;
      this.socks.set(id, sock);
      this.handlers.onConnection(id);
      sock.on('data', (b: Buffer) =>
        this.handlers.onData(id, new Uint8Array(b.buffer, b.byteOffset, b.byteLength)),
      );
      sock.on('close', () => {
        this.socks.delete(id);
        this.handlers.onClose(id);
      });
      sock.on('error', () => sock.destroy());
    });
    this.server.listen(port, '127.0.0.1');
    await once(this.server, 'listening');
    return (this.server.address() as AddressInfo).port;
  }

  async stop() {
    for (const s of this.socks.values()) s.destroy();
    this.socks.clear();
    this.server?.close();
  }
  send(connId: string, data: Uint8Array) {
    this.socks.get(connId)?.write(Buffer.from(data));
  }
  close(connId: string) {
    this.socks.get(connId)?.end();
  }
}

function versusWorld() {
  return createWorld({
    arena: loadArena(VERSUS_MAPS[0]),
    seed: 42,
    players: [
      { team: 0, spawnIndex: 0 },
      { team: 1, spawnIndex: 1 },
    ],
  });
}

test('a browser fetches the page from the host phone', { timeout: 15_000 }, async () => {
  const tcp = new NodeTcp();
  const host = new LanHost(tcp, { page: PAGE, port: 0 });
  const port = await host.start();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Tanks!<\/title>/);
  } finally {
    await host.stop();
  }
});

test('a real client plays a real match against the host', { timeout: 20_000 }, async () => {
  // The whole stack: a genuine TCP socket, a genuine WebSocket client, the
  // authoritative MatchHost, and a MatchClient predicting against it -- the
  // arrangement two phones will actually be in.
  const tcp = new NodeTcp();
  const lan = new LanHost(tcp, { page: PAGE, port: 0 });
  const port = await lan.start();

  const world = versusWorld();
  const matchHost = new MatchHost(world, lan.transport);

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.binaryType = 'arraybuffer';
    await once(ws, 'open');

    // Give the handshake a moment to register the peer host-side.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lan.playerIds.length, 1, 'the browser must be seated as a player');
    matchHost.addClient(lan.playerIds[0], 1);

    // Client half, exactly as the browser build wires it: a BridgeTransport
    // over the socket, feeding a MatchClient.
    const clientTransport = new BridgeTransport((_to, data) => ws.send(data), {
      kind: 4 as never,
    });
    ws.addEventListener('message', (ev) => {
      clientTransport.receive('host', new Uint8Array(ev.data as ArrayBuffer));
    });
    await clientTransport.join('host');
    const client = new MatchClient(cloneWorld(world), clientTransport, 'host', 1);

    // Drive both for a second of game time, with the client holding a
    // direction so its tank actually moves and can disagree with the host.
    client.setInput({ moveX: 1, moveY: 0, aimX: 1, aimY: 0, fire: false, layMine: false });
    for (let i = 0; i < 60; i++) {
      client.update(1000 / 60);
      matchHost.update(1000 / 60);
      await new Promise((r) => setTimeout(r, 1));
    }

    // The host must have received input and moved the client's tank. If the
    // socket path were broken this tank would sit exactly where it spawned.
    const hostTank = matchHost.world.tanks[1];
    const spawn = versusWorld().tanks[1];
    assert.notEqual(
      `${hostTank.x.toFixed(3)},${hostTank.y.toFixed(3)}`,
      `${spawn.x.toFixed(3)},${spawn.y.toFixed(3)}`,
      'the host must have moved the tank from input that crossed a real socket',
    );

    // And the client must have been corrected toward the host at some point,
    // which only happens if snapshots came back down the same socket.
    assert.ok(client.snapshotsApplied > 0, 'snapshots must reach the client');

    ws.close();
  } finally {
    await lan.stop();
  }
});

test('the host survives a player vanishing mid-match', { timeout: 20_000 }, async () => {
  const tcp = new NodeTcp();
  const lan = new LanHost(tcp, { page: PAGE, port: 0 });
  const port = await lan.start();
  const matchHost = new MatchHost(versusWorld(), lan.transport);

  try {
    const doomed = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(doomed, 'open');
    await new Promise((r) => setTimeout(r, 50));
    matchHost.addClient(lan.playerIds[0], 1);

    doomed.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(lan.playerIds, [], 'the departed phone loses its slot');

    // The match keeps running for whoever is left.
    for (let i = 0; i < 30; i++) matchHost.update(1000 / 60);

    const late = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(late, 'open');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lan.playerIds.length, 1, 'a new phone can still join afterwards');
    late.close();
  } finally {
    await lan.stop();
  }
});
