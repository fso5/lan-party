/**
 * Interop: our server against a real WebSocket client.
 *
 * The vector tests in `websocket.test.ts` prove the pieces match the spec on
 * paper. This proves the whole thing actually talks to an independent client
 * implementation -- Node's built-in WebSocket, which is undici's, which is not
 * ours and did not read our assumptions.
 *
 * That distinction is the entire point. The peer in production is Safari on
 * someone's iPhone, and there is no console on it. A handshake or framing
 * mistake that both of our own halves agree about would sail through a
 * round-trip test and then fail silently on a phone at a picnic table.
 *
 * Every test here carries an explicit timeout. A rejected handshake does not
 * produce an error -- the socket simply never opens -- so without one, a
 * handshake regression hangs CI forever instead of failing it.
 *
 * It also stands in for the real deployment shape: a socket that serves an
 * ordinary HTTP page to a browser *and* upgrades a second connection to carry
 * the game. Both run on one port because the host is a phone, and asking
 * someone to type a port number is a lost player.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';

import {
  WsDecoder,
  WsOpcode,
  encodeFrame,
  handshakeResponse,
  httpResponse,
  isWebSocketUpgrade,
  parseHttpRequest,
} from '@lan-party/net';

const PAGE = '<!doctype html><title>Tanks!</title><h1>🚀</h1>';

/**
 * The host phone's whole server, in the shape the app will run it: one TCP
 * listener that either serves the page or upgrades to a game connection.
 */
function startHost(onBinary: (sock: Socket, data: Uint8Array) => void) {
  const server = createServer((sock) => {
    let head = '';
    let upgraded = false;
    const dec = new WsDecoder();

    sock.on('data', (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

      if (upgraded) {
        for (const msg of dec.push(bytes)) {
          if (msg.opcode === WsOpcode.Binary) onBinary(sock, msg.data);
          else if (msg.opcode === WsOpcode.Ping) sock.write(encodeFrame(msg.data, WsOpcode.Pong));
          else if (msg.opcode === WsOpcode.Close) sock.end();
        }
        return;
      }

      head += Buffer.from(bytes).toString('latin1');
      const req = parseHttpRequest(head);
      if (!req) return; // Head still arriving.

      if (isWebSocketUpgrade(req)) {
        sock.write(handshakeResponse(req));
        upgraded = true;
        // Anything after the blank line is already WebSocket traffic. A server
        // that drops it loses the client's first packet, which on this game is
        // the join.
        const bodyAt = head.indexOf('\r\n\r\n') + 4;
        const extra = Buffer.from(head.slice(bodyAt), 'latin1');
        if (extra.length) {
          for (const msg of dec.push(new Uint8Array(extra))) {
            if (msg.opcode === WsOpcode.Binary) onBinary(sock, msg.data);
          }
        }
      } else {
        sock.write(httpResponse(new TextEncoder().encode(PAGE), 'text/html; charset=utf-8'));
        sock.end();
      }
    });
    sock.on('error', () => sock.destroy());
  });
  return server;
}

async function listen(server: ReturnType<typeof startHost>): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

test('a real browser-style client completes the handshake and exchanges binary', { timeout: 15_000 }, async () => {
  // Echo whatever arrives, so a mismatch anywhere in the path shows up as
  // wrong bytes rather than as a hang.
  const server = startHost((sock, data) => sock.write(encodeFrame(data)));
  const port = await listen(server);

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.binaryType = 'arraybuffer';
    await once(ws, 'open');

    // A snapshot-sized packet, and a payload crossing the 125/126 length
    // boundary where the header width changes.
    for (const size of [52, 125, 126, 300]) {
      const payload = Uint8Array.from({ length: size }, (_, i) => (i * 31) & 0xff);
      ws.send(payload);
      const [ev] = (await once(ws, 'message')) as [MessageEvent];
      assert.deepEqual(new Uint8Array(ev.data as ArrayBuffer), payload, `size ${size}`);
    }

    ws.close();
  } finally {
    server.close();
  }
});

test('the same port serves the game page to an ordinary HTTP request', { timeout: 15_000 }, async () => {
  // The iPhone loads the page from the host phone rather than from the cached
  // PWA, because an HTTPS page is not allowed to open a ws:// connection to a
  // local IP. So this listener has to be a web server as well as a game host.
  const server = startHost(() => {});
  const port = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await res.text(), PAGE, 'multi-byte characters must survive intact');
  } finally {
    server.close();
  }
});

test('several clients are served at once', { timeout: 15_000 }, async () => {
  // Four phones is the point of the exercise; a server that works for one
  // client and shares state badly across four is the default failure.
  const seen = new Map<string, number>();
  const server = startHost((sock, data) => {
    const key = `${(sock.address() as AddressInfo).port}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    sock.write(encodeFrame(data));
  });
  const port = await listen(server);

  try {
    const clients = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.binaryType = 'arraybuffer';
        await once(ws, 'open');
        return ws;
      }),
    );

    const replies = await Promise.all(
      clients.map(async (ws, i) => {
        ws.send(Uint8Array.of(i, i, i));
        const [ev] = (await once(ws, 'message')) as [MessageEvent];
        return new Uint8Array(ev.data as ArrayBuffer);
      }),
    );

    replies.forEach((r, i) => assert.deepEqual(r, Uint8Array.of(i, i, i), `client ${i}`));
    for (const ws of clients) ws.close();
  } finally {
    server.close();
  }
});

test('a client that disappears does not take the server with it', { timeout: 15_000 }, async () => {
  // Phones leave WiFi range mid-match. That has to be one dropped peer, not a
  // crashed host that ends everyone else's game.
  const server = startHost((sock, data) => sock.write(encodeFrame(data)));
  const port = await listen(server);

  try {
    const doomed = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(doomed, 'open');
    doomed.close();

    const survivor = new WebSocket(`ws://127.0.0.1:${port}`);
    survivor.binaryType = 'arraybuffer';
    await once(survivor, 'open');
    survivor.send(Uint8Array.of(42));
    const [ev] = (await once(survivor, 'message')) as [MessageEvent];
    assert.deepEqual(new Uint8Array(ev.data as ArrayBuffer), Uint8Array.of(42));
    survivor.close();
  } finally {
    server.close();
  }
});
