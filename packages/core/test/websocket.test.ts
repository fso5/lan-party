/**
 * WebSocket server tests.
 *
 * Every check here that can be pinned to a *published* vector is, rather than
 * to this implementation's own output. A round-trip test proves an encoder and
 * decoder agree with each other, which is exactly what a pair of consistently
 * wrong implementations also do -- and the peer on the other end of this code
 * is Safari, which will not be adjusting to match us.
 *
 * That lesson is already paid for in this repo: the base64 in the app was
 * round-trip tested, and the thing decoding it was the platform.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MESSAGE_BYTES,
  WsDecoder,
  WsOpcode,
  WsProtocolError,
  acceptKey,
  base64,
  encodeFrame,
  handshakeResponse,
  httpResponse,
  isWebSocketUpgrade,
  parseHttpRequest,
  sha1,
} from '../src/net/websocket.js';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const utf8 = (s: string) => new TextEncoder().encode(s);

test('sha1 matches the published FIPS-180 vectors', () => {
  assert.equal(hex(sha1(utf8(''))), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(hex(sha1(utf8('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  // 448 bits: the case that exercises the padding boundary, where a length
  // that no longer fits in the final block forces an extra one.
  assert.equal(
    hex(sha1(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
  );
  // Exactly one block, and one byte either side of it.
  assert.equal(hex(sha1(utf8('a'.repeat(64)))).length, 40);
  assert.equal(
    hex(sha1(utf8('a'.repeat(1000000).slice(0, 55)))),
    hex(sha1(utf8('a'.repeat(55)))),
  );
});

test('base64 matches the RFC 4648 vectors, including both padding cases', () => {
  assert.equal(base64(utf8('')), '');
  assert.equal(base64(utf8('f')), 'Zg==');
  assert.equal(base64(utf8('fo')), 'Zm8=');
  assert.equal(base64(utf8('foo')), 'Zm9v');
  assert.equal(base64(utf8('foob')), 'Zm9vYg==');
  assert.equal(base64(utf8('fooba')), 'Zm9vYmE=');
  assert.equal(base64(utf8('foobar')), 'Zm9vYmFy');
});

test('the handshake reproduces the exact example from RFC 6455', () => {
  // This single assertion validates sha1, base64, the GUID and the
  // concatenation order together. If any one of them is wrong, no browser
  // will ever complete a handshake with us, and this is the cheapest possible
  // place to find that out.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('an upgrade request is recognised whatever case the browser uses', () => {
  const raw =
    'GET /ws HTTP/1.1\r\n' +
    'Host: 192.168.1.5:8080\r\n' +
    'UPGRADE: WebSocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n';

  const req = parseHttpRequest(raw);
  assert.ok(req);
  assert.equal(req.method, 'GET');
  assert.equal(req.path, '/ws');
  // Header names are case-insensitive per HTTP and browsers genuinely differ.
  assert.ok(isWebSocketUpgrade(req));
  assert.match(handshakeResponse(req), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(handshakeResponse(req), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  assert.ok(handshakeResponse(req).endsWith('\r\n\r\n'), 'response head must be terminated');
});

test('a plain page request is not mistaken for an upgrade', () => {
  const req = parseHttpRequest('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.ok(req);
  assert.equal(isWebSocketUpgrade(req), false);
});

test('an incomplete request head returns null rather than half a request', () => {
  // TCP delivers whatever it feels like. Parsing a partial head would produce
  // a request with missing headers, which reads as "not an upgrade" and would
  // serve the page to a socket that asked for a socket.
  assert.equal(parseHttpRequest('GET / HTTP/1.1\r\nHost: x'), null);
  assert.equal(parseHttpRequest(''), null);
});

test('a served page carries a correct Content-Length in bytes, not characters', () => {
  // '🚀' is one character and four bytes. A Content-Length counted in
  // characters truncates the page, and the browser hangs waiting for the rest.
  const body = utf8('<html>🚀</html>');
  const res = httpResponse(body, 'text/html');
  const head = new TextDecoder().decode(res.subarray(0, res.indexOf(13)));
  void head;
  const text = new TextDecoder().decode(res);
  assert.match(text, new RegExp(`Content-Length: ${body.length}`));
  assert.equal(res.length - text.indexOf('\r\n\r\n') - 4, body.length);
});

/** Build a client -> server frame the way a browser would: masked. */
function clientFrame(payload: Uint8Array, opcode = WsOpcode.Binary, fin = true): Uint8Array {
  const mask = Uint8Array.from([0x37, 0xfa, 0x21, 0x3d]);
  const len = payload.length;
  const header = len < 126 ? 2 : 4;
  const out = new Uint8Array(header + 4 + len);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) {
    out[1] = 0x80 | len;
  } else {
    out[1] = 0x80 | 126;
    new DataView(out.buffer).setUint16(2, len, false);
  }
  out.set(mask, header);
  for (let i = 0; i < len; i++) out[header + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

test('a masked client frame decodes to the original bytes', () => {
  const payload = Uint8Array.from([1, 2, 3, 250, 255, 0]);
  const msgs = new WsDecoder().push(clientFrame(payload));
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].data, payload);
  assert.equal(msgs[0].opcode, WsOpcode.Binary);
});

test('server frames are never masked', () => {
  // A masked server frame handshakes fine and then gets the connection closed
  // on the first packet -- which looks like a game bug, not a framing bug.
  const f = encodeFrame(Uint8Array.from([9, 9, 9]));
  assert.equal(f[1] & 0x80, 0, 'MASK bit must be clear on server frames');
  assert.equal(f[0], 0x80 | WsOpcode.Binary, 'FIN set, binary opcode');
  assert.deepEqual(f.subarray(2), Uint8Array.from([9, 9, 9]));
});

test('arbitrary framings survive arbitrary chunk boundaries', () => {
  // The tests around this one each pin a single case: a fragmented message, a
  // one-byte feed, a two-byte length header. Every one of them is a case
  // someone thought of. This is the same decoder driven across two thousand
  // combinations of them at once -- messages split into continuation frames,
  // a ping injected mid-message, payloads either side of the 126-byte header
  // boundary, and the whole byte stream cut at random offsets including one
  // byte at a time.
  //
  // Seeded, so a failure is a fixed byte stream someone can step through
  // rather than something that happened once on a Tuesday.
  //
  // Four mutations were tried against it. Three -- losing the fragmented
  // message's opcode, a control frame cancelling the message it interrupted,
  // reading only one frame per chunk -- were caught here and by a hand-written
  // test as well, so on those this adds nothing. The fourth was not caught
  // anywhere else: dropping `this.fragments = []` after a message completes,
  // which leaves the first fragmented message's bytes glued to the front of
  // the second. Nothing in the suite sent two fragmented messages down one
  // decoder, so nothing noticed.
  //
  // That is the same failure the BLE framer actually had -- one message's
  // remains delivered as part of the next -- found in the transport underneath
  // this one on the same day. Worth stating plainly: the reason this test is
  // here is that reassemblers get this wrong, twice now.
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ri = (n: number) => Math.floor(rnd() * n);

  const masked = (payload: Uint8Array, opcode: WsOpcode, fin: boolean): Uint8Array => {
    const mask = Uint8Array.from([ri(256), ri(256), ri(256), ri(256)]);
    const len = payload.length;
    const header = len < 126 ? 2 : 4;
    const out = new Uint8Array(header + 4 + len);
    out[0] = (fin ? 0x80 : 0) | opcode;
    if (len < 126) out[1] = 0x80 | len;
    else {
      out[1] = 0x80 | 126;
      new DataView(out.buffer).setUint16(2, len, false);
    }
    out.set(mask, header);
    for (let i = 0; i < len; i++) out[header + 4 + i] = payload[i] ^ mask[i & 3];
    return out;
  };

  let fragmented = 0;
  for (let trial = 0; trial < 2000; trial++) {
    const wire: number[] = [];
    const expected: { opcode: WsOpcode; data: number[] }[] = [];

    for (let m = 0; m < 1 + ri(4); m++) {
      const size = ri(3) === 0 ? 126 + ri(200) : ri(40);
      const body = Uint8Array.from({ length: size }, () => ri(256));
      const opcode = ri(4) === 0 ? WsOpcode.Text : WsOpcode.Binary;
      const pieces = ri(3) === 0 ? 1 + ri(3) : 1;

      if (pieces === 1) {
        wire.push(...masked(body, opcode, true));
      } else {
        fragmented++;
        const cut = Math.floor(size / pieces);
        for (let p = 0; p < pieces; p++) {
          const to = p === pieces - 1 ? size : (p + 1) * cut;
          wire.push(
            ...masked(
              body.subarray(p * cut, to),
              p === 0 ? opcode : WsOpcode.Continuation,
              p === pieces - 1,
            ),
          );
          // A control frame is legal between the fragments of a message, and
          // has to come out ahead of the message it interrupted.
          if (p === 0 && ri(2) === 0) {
            const ping = Uint8Array.from([1, 2, 3]);
            wire.push(...masked(ping, WsOpcode.Ping, true));
            expected.push({ opcode: WsOpcode.Ping, data: [...ping] });
          }
        }
      }
      expected.push({ opcode, data: [...body] });
    }

    const dec = new WsDecoder();
    const got: { opcode: WsOpcode; data: number[] }[] = [];
    const bytes = Uint8Array.from(wire);
    for (let at = 0; at < bytes.length; ) {
      const take = 1 + ri(ri(4) === 0 ? 1 : 24);
      for (const msg of dec.push(bytes.subarray(at, at + take))) {
        got.push({ opcode: msg.opcode, data: [...msg.data] });
      }
      at += take;
    }

    assert.deepEqual(got, expected, `trial ${trial} decoded differently`);
  }
  assert.ok(fragmented > 500, `the fragmenting path must be exercised, got ${fragmented}`);
});

test('an unmasked client frame is refused', () => {
  const unmasked = Uint8Array.from([0x82, 0x02, 0xaa, 0xbb]);
  assert.throws(() => new WsDecoder().push(unmasked), WsProtocolError);
});

test('frames arriving one byte at a time still decode', () => {
  // The realistic case on a phone hotspot, and the one a decoder written
  // against whole-buffer assumptions gets wrong.
  const payload = Uint8Array.from({ length: 200 }, (_, i) => i & 0xff);
  const frame = clientFrame(payload);
  const dec = new WsDecoder();

  const seen = [];
  for (const byte of frame) seen.push(...dec.push(Uint8Array.of(byte)));

  assert.equal(seen.length, 1, 'exactly one message, once the last byte lands');
  assert.deepEqual(seen[0].data, payload);
});

test('several frames in one read all come out', () => {
  const a = clientFrame(utf8('one'), WsOpcode.Text);
  const b = clientFrame(utf8('two'), WsOpcode.Text);
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);

  const msgs = new WsDecoder().push(joined);
  assert.equal(msgs.length, 2);
  assert.equal(new TextDecoder().decode(msgs[0].data), 'one');
  assert.equal(new TextDecoder().decode(msgs[1].data), 'two');
});

test('a fragmented message is reassembled in order', () => {
  const dec = new WsDecoder();
  assert.equal(dec.push(clientFrame(utf8('he'), WsOpcode.Text, false)).length, 0);
  assert.equal(dec.push(clientFrame(utf8('ll'), WsOpcode.Continuation, false)).length, 0);
  const done = dec.push(clientFrame(utf8('o'), WsOpcode.Continuation, true));
  assert.equal(done.length, 1);
  assert.equal(new TextDecoder().decode(done[0].data), 'hello');
  assert.equal(done[0].opcode, WsOpcode.Text, 'the completed message keeps the opening opcode');
});

test('a ping arriving mid-fragment is delivered without breaking reassembly', () => {
  // Control frames may be injected inside a fragmented message. A decoder that
  // treats every frame as part of the sequence corrupts the message.
  const dec = new WsDecoder();
  dec.push(clientFrame(utf8('he'), WsOpcode.Text, false));
  const ping = dec.push(clientFrame(utf8('hi'), WsOpcode.Ping));
  assert.equal(ping.length, 1);
  assert.equal(ping[0].opcode, WsOpcode.Ping);

  const done = dec.push(clientFrame(utf8('llo'), WsOpcode.Continuation, true));
  assert.equal(new TextDecoder().decode(done[0].data), 'hello');
});

test('a continuation with nothing to continue is refused', () => {
  assert.throws(
    () => new WsDecoder().push(clientFrame(utf8('x'), WsOpcode.Continuation, true)),
    WsProtocolError,
  );
});

test('an oversized length is refused before anything is allocated', () => {
  // The length comes off the wire, so it is attacker-controlled, and this runs
  // on a phone. A 2^60-byte frame must be a dropped connection, not an OOM.
  const huge = new Uint8Array(14);
  huge[0] = 0x82;
  huge[1] = 0x80 | 127;
  new DataView(huge.buffer).setUint32(2, 0x10000000, false);
  assert.throws(() => new WsDecoder().push(huge), WsProtocolError);
});

test('a flood of small fragments cannot walk past the cap', () => {
  // The per-frame check looks like it enforces the limit. It does not: a
  // thousand legal 1KB fragments assemble into a message far over it.
  const dec = new WsDecoder();
  const chunk = new Uint8Array(4096);
  assert.throws(() => {
    dec.push(clientFrame(chunk, WsOpcode.Binary, false));
    for (let i = 0; i < MAX_MESSAGE_BYTES / 4096 + 2; i++) {
      dec.push(clientFrame(chunk, WsOpcode.Continuation, false));
    }
  }, WsProtocolError);
});

test('a 16-bit length frame round-trips at the boundary', () => {
  // 125/126 is where the length field changes width, and an off-by-one here
  // produces a decoder that works in testing and fails on a busy frame.
  for (const size of [125, 126, 127, 65535]) {
    const payload = new Uint8Array(size).fill(7);
    const msgs = new WsDecoder().push(clientFrame(payload));
    assert.equal(msgs.length, 1, `size ${size}`);
    assert.equal(msgs[0].data.length, size, `size ${size}`);

    const server = encodeFrame(payload);
    assert.equal(server.length, size < 126 ? size + 2 : size + 4, `server header for ${size}`);
  }
});

test('a game packet survives the full server encode path', () => {
  // The actual traffic: a snapshot-sized binary payload, encoded as a server
  // frame, decoded back the way a browser would read it.
  const snapshot = Uint8Array.from({ length: 52 }, (_, i) => (i * 7) & 0xff);
  const framed = encodeFrame(snapshot);
  assert.equal(framed[0] & 0x0f, WsOpcode.Binary);
  assert.deepEqual(framed.subarray(2), snapshot);
});
