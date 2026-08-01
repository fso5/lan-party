/**
 * A WebSocket *server*, in TypeScript, with no dependencies.
 *
 * ## Why this exists
 *
 * The delivery constraint is: phones in a room, no internet, and no paid Apple
 * Developer account. An iPhone cannot be given a native app under those terms,
 * and iOS Safari has no Web Bluetooth -- so the only thing an iPhone can join
 * is a web page. Something has to serve that page and host the match, and the
 * Android phone is the only device in the room that can listen on a socket.
 *
 * Browsers ship a WebSocket *client*. Nothing ships a server, and the Android
 * app is where one has to run. Hence this.
 *
 * ## Why TypeScript rather than Kotlin
 *
 * The native surface shrinks to "give me a TCP socket", which is a thin,
 * well-supported thing to ask a platform for. Everything above it -- the
 * handshake, framing, masking, fragmentation -- is ordinary byte manipulation
 * that runs and is tested in Node, on the machine writing it. Written in
 * Kotlin, every one of those details could only be compiled and hoped about
 * until two phones were in the same room.
 *
 * That trade matters here more than usual: there is no debugger on the far side
 * of this code. A framing bug on a phone at a picnic table presents as "it
 * doesn't work".
 *
 * ## Scope
 *
 * Deliberately not a general WebSocket implementation. It speaks exactly the
 * subset a browser uses to play this game -- binary frames, ping/pong, close --
 * and refuses anything else loudly rather than half-supporting it. No
 * extensions, no compression, no TLS (this is a local network with no internet;
 * there is no certificate to be had and no origin to protect).
 */

/** RFC 6455's handshake constant. Fixed by the spec; not a secret. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export enum WsOpcode {
  Continuation = 0x0,
  Text = 0x1,
  Binary = 0x2,
  Close = 0x8,
  Ping = 0x9,
  Pong = 0xa,
}

/**
 * Largest message we will assemble, in bytes.
 *
 * Game packets are capped at 180 bytes by the BLE budget, so this is three
 * orders of magnitude of headroom. It exists because the length field comes
 * off the wire: without a cap, a corrupt or hostile 8-byte length asks us to
 * buffer gigabytes, and the phone dies with an out-of-memory rather than
 * dropping one bad connection. Same reasoning as the bounds checks in the
 * packet Reader.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------
 * SHA-1 and base64
 *
 * Needed only for the handshake. Implemented here rather than pulled in so
 * core keeps its no-dependency property -- it has to run in Node, in a
 * browser, and in React Native without conditional imports, and the crypto
 * APIs available in those three environments are all different and mostly
 * async.
 *
 * SHA-1 is used here purely as the fixed checksum RFC 6455 specifies for
 * proving a handshake was understood. It carries no security weight in this
 * protocol, and its collision weakness is irrelevant to that job.
 * ---------------------------------------------------------------------- */

function rotl(n: number, b: number): number {
  return ((n << b) | (n >>> (32 - b))) >>> 0;
}

export function sha1(msg: Uint8Array): Uint8Array {
  const bitLen = msg.length * 8;

  // Pad: a 1 bit, then zeros, until 8 bytes short of a block, then the
  // original length as a 64-bit big-endian count of bits.
  const withPad = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
  withPad.set(msg);
  withPad[msg.length] = 0x80;

  const dv = new DataView(withPad.buffer);
  // Lengths here never approach 2^32 bits, so the high word is always zero.
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let i = 0; i < withPad.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let j = 0; j < 80; j++) {
      let f: number;
      let k: number;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[j]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  new DataView(out.buffer).setUint32(0, h0, false);
  new DataView(out.buffer).setUint32(4, h1, false);
  new DataView(out.buffer).setUint32(8, h2, false);
  new DataView(out.buffer).setUint32(12, h3, false);
  new DataView(out.buffer).setUint32(16, h4, false);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

/** The `Sec-WebSocket-Accept` value proving we understood the handshake. */
export function acceptKey(clientKey: string): string {
  return base64(sha1(new TextEncoder().encode(clientKey + WS_GUID)));
}

/* -------------------------------------------------------------------------
 * HTTP
 * ---------------------------------------------------------------------- */

export interface HttpRequest {
  method: string;
  path: string;
  headers: Map<string, string>;
}

/**
 * Parse a request head. Returns null while the head is still incomplete, so a
 * caller can feed partial TCP reads without buffering logic of its own.
 *
 * Header names are lowercased on the way in. HTTP says they are
 * case-insensitive, and browsers do not agree on capitalisation --
 * `Sec-WebSocket-Key` arrives with at least two spellings in the wild.
 */
export function parseHttpRequest(text: string): HttpRequest | null {
  const end = text.indexOf('\r\n\r\n');
  if (end === -1) return null;

  const lines = text.slice(0, end).split('\r\n');
  const [method = '', path = ''] = lines[0].split(' ');

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { method, path, headers };
}

/** True if this request is a browser asking to upgrade to a WebSocket. */
export function isWebSocketUpgrade(req: HttpRequest): boolean {
  return (
    (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket' &&
    req.headers.has('sec-websocket-key')
  );
}

/** The 101 response completing the handshake. */
export function handshakeResponse(req: HttpRequest): string {
  const key = req.headers.get('sec-websocket-key');
  if (!key) throw new Error('not a WebSocket upgrade: no Sec-WebSocket-Key');
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
}

/**
 * A plain HTTP response, used to serve the game page itself.
 *
 * `Cache-Control: no-store` is deliberate. The host phone reserves the right to
 * be rebuilt between matches, and a stale cached page that speaks an older wire
 * protocol fails in a way nobody at a picnic table will diagnose.
 */
export function httpResponse(body: Uint8Array, contentType: string): Uint8Array {
  const head = new TextEncoder().encode(
    'HTTP/1.1 200 OK\r\n' +
      `Content-Type: ${contentType}\r\n` +
      `Content-Length: ${body.length}\r\n` +
      'Cache-Control: no-store\r\n' +
      'Connection: close\r\n\r\n',
  );
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/* -------------------------------------------------------------------------
 * Framing
 * ---------------------------------------------------------------------- */

/**
 * Encode one server -> client frame.
 *
 * Server frames must never be masked (RFC 6455 §5.1). Browsers close the
 * connection on a masked server frame, so getting this backwards produces a
 * connection that handshakes cleanly and then dies on the first packet.
 */
export function encodeFrame(payload: Uint8Array, opcode: WsOpcode = WsOpcode.Binary): Uint8Array {
  const len = payload.length;
  const header = len < 126 ? 2 : len <= 0xffff ? 4 : 10;
  const out = new Uint8Array(header + len);

  out[0] = 0x80 | opcode; // FIN set: we never fragment outbound.

  if (len < 126) {
    out[1] = len;
  } else if (len <= 0xffff) {
    out[1] = 126;
    new DataView(out.buffer).setUint16(2, len, false);
  } else {
    out[1] = 127;
    new DataView(out.buffer).setUint32(2, 0, false);
    new DataView(out.buffer).setUint32(6, len, false);
  }

  out.set(payload, header);
  return out;
}

export interface WsMessage {
  opcode: WsOpcode;
  data: Uint8Array;
}

/** Raised for anything that means the connection must be dropped. */
export class WsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsProtocolError';
  }
}

/**
 * Incremental decoder for one connection.
 *
 * TCP is a byte stream with no respect for message boundaries: a read can
 * deliver half a frame, three frames, or a frame split mid-header. Everything
 * here is written to survive being fed one byte at a time, because on a phone
 * hotspot it eventually will be.
 */
export class WsDecoder {
  private buf = new Uint8Array(0);
  /** Accumulated payload of a fragmented message. */
  private fragments: Uint8Array[] = [];
  private fragmentOpcode: WsOpcode | null = null;
  private fragmentBytes = 0;

  /** Feed raw bytes; returns whatever complete messages they finished. */
  push(chunk: Uint8Array): WsMessage[] {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;

    const out: WsMessage[] = [];
    for (;;) {
      const msg = this.readOne();
      if (!msg) break;
      if (msg !== SKIP) out.push(msg);
    }
    return out;
  }

  private readOne(): WsMessage | typeof SKIP | null {
    const b = this.buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = (b[0] & 0x0f) as WsOpcode;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < 4) return null;
      len = new DataView(b.buffer, b.byteOffset).getUint16(2, false);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const dv = new DataView(b.buffer, b.byteOffset);
      const high = dv.getUint32(2, false);
      const low = dv.getUint32(6, false);
      // Reject before allocating. A 64-bit length is attacker-controlled and
      // this runs on a phone.
      if (high !== 0 || low > MAX_MESSAGE_BYTES) {
        throw new WsProtocolError(`frame of ${high * 0x100000000 + low} bytes exceeds the limit`);
      }
      len = low;
      offset = 10;
    }

    if (len > MAX_MESSAGE_BYTES) {
      throw new WsProtocolError(`frame of ${len} bytes exceeds the ${MAX_MESSAGE_BYTES} limit`);
    }

    // Every client -> server frame must be masked. An unmasked one means a
    // confused or hostile client, and the spec says fail the connection.
    if (!masked) throw new WsProtocolError('client frame was not masked');

    if (b.length < offset + 4 + len) return null;
    const mask = b.subarray(offset, offset + 4);
    offset += 4;

    const payload = new Uint8Array(len);
    for (let i = 0; i < len; i++) payload[i] = b[offset + i] ^ mask[i & 3];

    this.buf = b.subarray(offset + len);

    // Control frames may be injected mid-fragment and are never fragmented.
    if (opcode === WsOpcode.Close || opcode === WsOpcode.Ping || opcode === WsOpcode.Pong) {
      if (!fin) throw new WsProtocolError('control frame must not be fragmented');
      return { opcode, data: payload };
    }

    if (opcode === WsOpcode.Continuation) {
      if (this.fragmentOpcode === null) throw new WsProtocolError('continuation without a start');
      this.addFragment(payload);
    } else {
      if (this.fragmentOpcode !== null) throw new WsProtocolError('new message before the last finished');
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.addFragment(payload);
        return SKIP;
      }
      return { opcode, data: payload };
    }

    if (!fin) return SKIP;

    const joined = new Uint8Array(this.fragmentBytes);
    let at = 0;
    for (const f of this.fragments) {
      joined.set(f, at);
      at += f.length;
    }
    const result = { opcode: this.fragmentOpcode, data: joined };
    this.fragments = [];
    this.fragmentOpcode = null;
    this.fragmentBytes = 0;
    return result;
  }

  private addFragment(payload: Uint8Array): void {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
      // Otherwise a stream of small fragments walks past the cap that the
      // per-frame check appears to enforce.
      throw new WsProtocolError(`fragmented message exceeds the ${MAX_MESSAGE_BYTES} limit`);
    }
    this.fragments.push(payload);
  }
}

/** Sentinel: a frame was consumed but completed no message. */
const SKIP = Symbol('skip') as unknown as WsMessage;
