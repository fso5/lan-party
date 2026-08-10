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

  /**
   * Begin listening, falling back to any free port if the preferred one is
   * taken.
   *
   * 8080 is memorable and needs no privileges, which is why it is the default
   * -- but a phone is a whole computer and something else may already be on
   * it. Measured: the bind throws `EADDRINUSE`, the host screen shows "listen
   * EADDRINUSE: address already in use 0.0.0.0:8080", and there is no way to
   * choose a different port from a phone. Hosting is simply impossible until
   * the player finds and kills whatever is squatting.
   *
   * An ephemeral port is worse to read out -- "colon four one seven two nine"
   * against "colon eight zero eight zero" -- and enormously better than not
   * playing. It only happens when the nice number is unavailable, and the URL
   * is on screen either way.
   *
   * The first error is what surfaces if the retry fails too. That one names
   * the port somebody chose; the second names a port nobody asked for.
   */
  async start(): Promise<number> {
    try {
      this.port = await this.tcp.start(this.port);
    } catch (err) {
      // Retrying 0 with 0 would just fail the same way, and the failure is
      // then about something other than the port being taken.
      if (this.port === 0) throw err;
      try {
        this.port = await this.tcp.start(0);
      } catch {
        throw err;
      }
    }
    this.started = true;
    return this.port;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.conns.clear();
    await this.tcp.stop();
  }

  /**
   * The URL to read out. Null until there is a server behind it.
   *
   * `started` matters as much as the address. Without that check this answered
   * with a perfectly plausible URL after `start()` had thrown -- a port nothing
   * was listening on, which is the same dead end as the wrong interface and
   * looks just as convincing.
   */
  get joinUrl(): string | null {
    if (!this.started) return null;
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

  /**
   * No cap on how many connections are held, and that is the measured answer
   * rather than an omission.
   *
   * Every other buffer in this file states its bound, so this one should say
   * why it has none. Driven against a stub socket layer, with the map watched
   * throughout:
   *
   *     a browser fetches the page, then closes      0 held
   *     50 connections open, saying nothing          50, then 0 on close
   *     one connection sends 83,600 bytes of header  0 -- MAX_HEAD_BYTES drops it
   *     500 opened and never closed                  500
   *
   * So every path where either side ends the connection drains, including the
   * abusive one, and the only way the map grows is sockets the platform never
   * reports closed. That is the socket layer's count to bound, not this one's,
   * and each entry is capped at MAX_HEAD_BYTES until it upgrades.
   *
   * A cap here was considered and rejected on those numbers. It would defend
   * only against a platform that has stopped reporting closes, and the cost of
   * getting it wrong is refusing a real player -- on the WiFi path, which is
   * the only way an iPhone can play at all.
   */
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

  /**
   * Everything a socket read can reach, behind one net.
   *
   * The guards inside `pump` handle the two cases with a sensible recovery and
   * a name worth reporting. This is the backstop for everything else on the
   * path -- notably `onPlayerJoin`, which is an app callback (a lobby seating
   * the new player) invoked straight from a socket read. A throw anywhere in
   * here reaches the platform as an unhandled error on the JS thread, and on
   * the host phone that ends the match for every player at once.
   *
   * One connection is always the cheaper thing to lose than the host, so the
   * rule is absolute and stated in one place rather than argued per call site.
   */
  private receive(id: string, data: Uint8Array): void {
    try {
      this.receiveOrThrow(id, data);
    } catch (err) {
      this.onError?.('receive', err instanceof Error ? err.message : String(err));
      this.tcp.close(id);
      this.drop(id);
    }
  }

  private receiveOrThrow(id: string, data: Uint8Array): void {
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
        /*
         * The framing guard above is not enough on its own.
         *
         * A frame can be perfectly legal WebSocket and still carry a payload
         * the game protocol cannot read -- an `Input` header with no input
         * behind it. `Reader` is bounds-checked and throws, which is right,
         * but the throw comes back out through here and out of the socket
         * callback that delivered the bytes. On the host phone that is an
         * unhandled error on the JS thread: the match ends for *everyone*
         * because one device sent a few bad bytes.
         *
         * It does not take malice to reach. A tab reloading mid-write, or a
         * player whose browser cached the page from an older build, produces
         * exactly this -- and anything else on the hotspot can just open the
         * port and send whatever it likes.
         *
         * Same verdict as a framing error, for the same reason: a peer that
         * cannot speak this protocol will not start, so drop that one
         * connection and keep hosting. Catching everything rather than only
         * protocol errors is deliberate -- the cost of a mistake in a game
         * handler is one player's connection, and the cost of not catching it
         * is the host, so the asymmetry only points one way.
         */
        try {
          this.transport.receive(conn.id, msg.data);
        } catch (err) {
          this.onError?.('packet', err instanceof Error ? err.message : String(err));
          this.tcp.close(conn.id);
          this.drop(conn.id);
          // The rest of this batch belongs to a connection that no longer
          // exists; delivering it would reach handlers for a departed peer.
          return;
        }
      } else if (msg.opcode === WsOpcode.Ping) {
        this.tcp.send(conn.id, encodeFrame(msg.data, WsOpcode.Pong));
      } else if (msg.opcode === WsOpcode.Close) {
        this.tcp.close(conn.id);
        this.drop(conn.id);
      }
    }
  }
}

/** One address the device holds, as the platform reports it. */
export interface AddressCandidate {
  /** Interface name, e.g. "wlan0", "ap0", "rmnet_data0". */
  name: string;
  /** IPv4 or IPv6 literal. */
  address: string;
}

/**
 * Choose the address to read out loud.
 *
 * A phone hosting a hotspot has more than one address, and the interesting one
 * is not first. Alongside the tether interface there is usually a live
 * cellular interface with a carrier-assigned IPv4, and Java's
 * `NetworkInterface.getNetworkInterfaces()` makes no promise about order --
 * cellular commonly comes first. Taking the first non-loopback address, which
 * is what the native module did, therefore produces a URL that is *reachable
 * from the internet's point of view and from nobody on the hotspot*. Four
 * people type it in and get nothing, and the README blames hotspot client
 * isolation.
 *
 * There is no API that says "this is the tether interface", so this scores
 * candidates on the two things that do correlate and takes the best. Ties keep
 * the platform's order.
 *
 * Deliberately here rather than in Kotlin. The native module's own header says
 * nothing down there should decide anything, because code on the phone can
 * only be exercised by two people standing in a room -- and this is a decision
 * with a table of cases, which is exactly what wants a test.
 */
export function pickHostAddress(candidates: readonly AddressCandidate[]): string | null {
  let best: { score: number; address: string } | null = null;

  for (const c of candidates) {
    const address = c.address.trim();
    // IPv6 is skipped rather than scored: a link-local literal is unusable for
    // the thing this exists for, which is somebody reading it out and somebody
    // else typing it into Safari.
    if (!address || address.includes(':')) continue;
    if (address.startsWith('127.')) continue;
    // 169.254/16 is what an interface has when configuration failed.
    if (address.startsWith('169.254.')) continue;

    const name = c.name.toLowerCase();

    /*
     * Two things are rejected rather than scored, because they are not local
     * addresses at all -- no phone in the room can reach them however they
     * rank against the alternatives.
     *
     * Returning null when they are all that is left is the useful answer, not
     * a defeat: the host screen already says "No network address yet. Turn on
     * your hotspot, then tap Host again", which is exactly the instruction
     * somebody who has not started tethering needs. Handing them a carrier
     * address instead produces a URL four people type in for nothing.
     *
     * The asymmetry is deliberate. Rejecting a working setup by mistake shows
     * a hotspot prompt to somebody whose hotspot is on -- irritating, visible,
     * recoverable. Accepting a carrier address shows a confident URL that
     * cannot work, with nothing on screen to suggest why.
     */
    if (/^(rmnet|ccmni|pdp|clat|v4-rmnet|seth_)/.test(name)) continue;
    // 100.64/10 is carrier-grade NAT. It looks private, which makes it the
    // most convincing wrong answer available.
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) continue;

    let score = 0;

    // Android's tether interfaces. Names vary by vendor, which is why this is a
    // preference and not a filter. `usb`/`rndis` are deliberately absent from
    // the rejection above: USB tethering is a real local network, usually on
    // 192.168.42/24, and rejecting it would break a setup that works.
    if (/^(ap\d|swlan|softap|wlan1|p2p-)/.test(name)) score += 4;

    if (address.startsWith('192.168.43.')) score += 3; // Android's classic tether subnet
    else if (address.startsWith('192.168.')) score += 2;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 1;
    // 10/8 scores nothing on purpose -- both tethers and routers use it, so it
    // carries no signal either way.

    if (!best || score > best.score) best = { score, address };
  }

  return best?.address ?? null;
}
