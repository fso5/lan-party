/**
 * Hosting a match over WiFi.
 *
 * One phone runs this. It does two jobs on a single port:
 *
 *   1. Serves the game page over plain HTTP, to any browser that asks.
 *   2. Upgrades a second connection from that same page to a WebSocket, and
 *      carries the match over it.
 *
 * Both on one port because the host is a phone and the URL gets read out loud.
 * "One nine two dot one six eight dot four three dot one, colon eight zero
 * eight zero" is already at the edge of what a room will tolerate; a second
 * port number is a lost player.
 *
 * ## Why the page is served rather than cached
 *
 * The obvious design is for everyone to open the installed web app and point it
 * at the host. It cannot work: the installed app is served over HTTPS, and an
 * HTTPS page is not permitted to open a `ws://` connection to a local IP -- the
 * browser blocks it as mixed content, with no override. So the page a phone
 * plays from has to come from the host itself, over http, from the same origin
 * as the socket.
 *
 * That constraint is the entire reason this is an HTTP server and not just a
 * socket, and it is worth stating plainly because it looks like an arbitrary
 * decision until you hit the block.
 *
 * ## The socket is an interface
 *
 * `TcpServer` is deliberately the whole platform surface -- accept, read, write,
 * close. Everything above it, which is all the parts that can be subtly wrong,
 * runs and is tested here. The native side is left with nothing that needs a
 * test, which matters because the native side is the part that can only be
 * exercised by two people standing in a room with two phones.
 */

import { BridgeTransport } from './bridge.js';
import { TransportKind, type Peer, type PeerId } from './transport.js';
import {
  WsDecoder,
  WsOpcode,
  encodeFrame,
  handshakeResponse,
  httpResponse,
  isWebSocketUpgrade,
  parseHttpRequest,
} from './websocket.js';

export interface TcpConnectionHandlers {
  onConnection(connId: string): void;
  onData(connId: string, data: Uint8Array): void;
  onClose(connId: string): void;
  onError(where: string, message: string): void;
}

/**
 * The platform's TCP listener. Implemented natively per platform; faked in
 * tests.
 */
export interface TcpServer {
  /** Begin listening. Resolves with the port actually bound. */
  start(port: number): Promise<number>;
  stop(): Promise<void>;
  send(connId: string, data: Uint8Array): void;
  close(connId: string): void;
  setHandlers(handlers: TcpConnectionHandlers): void;
  /** This device's address on the local network, for building the join URL. */
  getIpAddress(): string | null;
}

/** Default port. 8080 is memorable and needs no privileges. */
export const DEFAULT_LAN_PORT = 8080;

/**
 * Cap on an un-upgraded request head.
 *
 * A connection that sends headers forever must not grow a buffer forever. The
 * real ceiling is a browser's request head, a couple of KB at most.
 */
const MAX_HEAD_BYTES = 16 * 1024;

interface Conn {
  id: string;
  upgraded: boolean;
  /** Request head accumulated as latin1, so byte offsets stay byte offsets. */
  head: string;
  decoder: WsDecoder;
}

export interface LanHostOptions {
  /** The game page, already encoded. Served to any plain HTTP request. */
  page: Uint8Array;
  port?: number;
  /**
   * Payload ceiling handed to the transport. Defaults to the BLE limit even
   * though WiFi could carry far more -- so a match developed over WiFi cannot
   * come to depend on packet sizes a radio would refuse, and the two transports
   * stay swappable.
   */
  maxPayload?: number;
}

export class LanHost {
  readonly transport: BridgeTransport;

  private conns = new Map<string, Conn>();
  private port: number;
  private page: Uint8Array;
  private started = false;

  /** Raised for anything worth showing the person holding the phone. */
  onError: ((where: string, message: string) => void) | null = null;
  /** A browser finished the handshake and is now a player. */
  onPlayerJoin: ((peer: Peer) => void) | null = null;
  onPlayerLeave: ((peerId: PeerId) => void) | null = null;

  constructor(
    private tcp: TcpServer,
    options: LanHostOptions,
  ) {
    this.page = options.page;
    this.port = options.port ?? DEFAULT_LAN_PORT;

    this.transport = new BridgeTransport(
      (to, data) => {
        const conn = this.conns.get(to);
        // Sending to a peer that just vanished is ordinary, not an error:
        // packets are queued a tick before they go out, and phones leave.
        if (conn?.upgraded) this.tcp.send(to, encodeFrame(data, WsOpcode.Binary));
      },
      { maxPayload: options.maxPayload ?? 180, kind: TransportKind.Lan },
    );

    this.tcp.setHandlers({
      onConnection: (id) => this.accept(id),
      onData: (id, data) => this.receive(id, data),
      onClose: (id) => this.drop(id),
      onError: (where, message) => this.onError?.(where, message),
    });
  }

  async start(): Promise<number> {
    this.port = await this.tcp.start(this.port);
    this.started = true;
    return this.port;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.conns.clear();
    await this.tcp.stop();
  }

  /** The URL to read out. Null until an address exists to put in it. */
  get joinUrl(): string | null {
    const ip = this.tcp.getIpAddress();
    return ip ? `http://${ip}:${this.port}` : null;
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** Peers currently playing, as opposed to merely connected. */
  get playerIds(): PeerId[] {
    return this.transport.peerIds;
  }

  private accept(id: string): void {
    this.conns.set(id, { id, upgraded: false, head: '', decoder: new WsDecoder() });
  }

  private drop(id: string): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    if (conn.upgraded) {
      this.transport.removePeer(id, 'left');
      this.onPlayerLeave?.(id);
    }
  }

  private receive(id: string, data: Uint8Array): void {
    const conn = this.conns.get(id);
    if (!conn) return;

    if (conn.upgraded) {
      this.pump(conn, data);
      return;
    }

    // Still reading the request head. latin1 keeps one byte to one character,
    // so an offset found in the string is an offset into the bytes -- decoding
    // as UTF-8 here would shift every offset the moment a header held a
    // non-ASCII byte.
    for (const byte of data) conn.head += String.fromCharCode(byte);

    if (conn.head.length > MAX_HEAD_BYTES) {
      this.onError?.('http', 'request head too large');
      this.tcp.close(id);
      // Forget it as well as closing it. Closing a socket does not stop bytes
      // already in flight from arriving, and a connection left in the map goes
      // on appending to the same oversized buffer -- re-reporting the error on
      // every read, which is the opposite of what the cap is for.
      this.drop(id);
      return;
    }

    const req = parseHttpRequest(conn.head);
    if (!req) return; // Head still arriving.

    if (isWebSocketUpgrade(req)) {
      try {
        this.tcp.send(id, new TextEncoder().encode(handshakeResponse(req)));
      } catch (err) {
        this.onError?.('handshake', err instanceof Error ? err.message : String(err));
        this.tcp.close(id);
        return;
      }
      conn.upgraded = true;

      const peer: Peer = { id, name: id, rtt: -1 };
      this.transport.addPeer(peer);
      this.onPlayerJoin?.(peer);

      // Bytes after the blank line are already WebSocket traffic. TCP does not
      // respect message boundaries, so the client's first frame routinely
      // arrives in the same read as its handshake -- and that first frame is
      // the join. Dropping it loses the player silently.
      const bodyAt = conn.head.indexOf('\r\n\r\n') + 4;
      const extra = conn.head.slice(bodyAt);
      conn.head = '';
      if (extra.length) {
        const bytes = new Uint8Array(extra.length);
        for (let i = 0; i < extra.length; i++) bytes[i] = extra.charCodeAt(i) & 0xff;
        this.pump(conn, bytes);
      }
      return;
    }

    // Anything else is a browser asking for the game. Serve it and hang up:
    // the page opens its own socket, so this connection has no further use.
    this.tcp.send(id, httpResponse(this.page, 'text/html; charset=utf-8'));
    this.tcp.close(id);
    this.conns.delete(id);
  }

  private pump(conn: Conn, data: Uint8Array): void {
    let messages;
    try {
      messages = conn.decoder.push(data);
    } catch (err) {
      // A framing error means this connection is unusable. It must not take
      // the host down -- everyone else is still mid-match.
      this.onError?.('frame', err instanceof Error ? err.message : String(err));
      this.tcp.close(conn.id);
      this.drop(conn.id);
      return;
    }

    for (const msg of messages) {
      if (msg.opcode === WsOpcode.Binary) {
        this.transport.receive(conn.id, msg.data);
      } else if (msg.opcode === WsOpcode.Ping) {
        this.tcp.send(conn.id, encodeFrame(msg.data, WsOpcode.Pong));
      } else if (msg.opcode === WsOpcode.Close) {
        this.tcp.close(conn.id);
        this.drop(conn.id);
      }
    }
  }
}
