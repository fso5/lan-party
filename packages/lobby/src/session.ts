/**
 * Lobby session: seating players and agreeing on teams before a match.
 *
 * Ported from Session B's `b/lobby` (PR #8), which wrote it for the retired
 * native app, with the three fixes the review in issue #9 asked for:
 *
 *  1. A joiner in free-for-all gets the lowest team nobody holds. It used to get
 *     `slots.length`, which after a departure is a team somebody already has --
 *     `Host=t0 B=t2`, then C joins as t2, and B and C cannot hurt each other.
 *  2. The seat cap is `MAX_LOBBY_SLOTS`, the same constant `readRoster` refuses
 *     above, rather than a local copy that could drift past it.
 *  3. A client's requests go to its host with `send`, not `broadcast`.
 *
 * Free of any UI so the state machine is testable on its own; a screen
 * subscribes through `onChange`. And free of any game: it works over any
 * `Transport`, including LanHost's, where `host()` and `discover()` are no-ops.
 *
 * ## The host is authoritative and clients only request
 *
 * A client tapping "team 2" sends `SetTeam` and changes nothing locally -- it
 * waits for the roster to come back. Two people tapping the same team at once is
 * ordinary, and an optimistic local change leaves two phones disagreeing about
 * who is on which side right up until the match starts.
 *
 * ## Slots are identified by slotId, never by array position
 *
 * A player leaving shifts every later index. `slotId` is assigned by the host
 * and survives departures, which is why `Welcome` exists at all: a broadcast
 * roster cannot tell each client which row is itself.
 *
 * ## Sharing the transport with a match
 *
 * `Transport.setEvents` merges handler by handler, so installing `onPacket`
 * here replaces any `onPacket` a match installed, and the other way round. The
 * two cannot both hold it. So `handlePacket` is public and says whether it used
 * the packet: once a match takes the transport, its dispatcher forwards
 * anything tagged `LOBBY_MSG` here.
 */

import { Reader, Writer, type Peer, type PeerId, type Transport } from '@lan-party/net';
import {
  LOBBY_MSG,
  LobbyOp,
  MAX_LOBBY_SLOTS,
  clampName,
  readRoster,
  writeLobbyJoin,
  writeLobbySetReady,
  writeLobbySetTeam,
  writeLobbyWelcome,
  writeRoster,
  type WireLobbySlot,
  type WireRoster,
} from './protocol.js';

export type LobbyRole = 'idle' | 'hosting' | 'browsing' | 'joined';

export interface DiscoveredHost {
  id: PeerId;
  name: string;
}

/** Free-for-all vs teams is a label for the UI; games key hostility off `team`. */
export const MODE_FFA = 0;
export const MODE_TEAMS = 1;

export interface LobbyState {
  role: LobbyRole;
  /** Populated while browsing. */
  hosts: DiscoveredHost[];
  roster: WireRoster;
  /** Which slot this device is. -1 until Welcome arrives (or, hosting, 0). */
  mySlotId: number;
  error: string | null;
}

function emptyRoster(): WireRoster {
  return { mapId: 0, mode: MODE_FFA, roundsToWin: 3, slots: [] };
}

function idleState(): LobbyState {
  return { role: 'idle', hosts: [], roster: emptyRoster(), mySlotId: -1, error: null };
}

export class LobbySession {
  private state: LobbyState = idleState();

  /** Host only: which peer occupies which slot. */
  private peerBySlot = new Map<number, PeerId>();
  private nextSlotId = 0;
  /** Client only: the host this session joined, so requests go to it alone. */
  private hostId: PeerId | null = null;

  onChange: (() => void) | null = null;

  constructor(
    private transport: Transport,
    private localName: string,
  ) {}

  get(): Readonly<LobbyState> {
    return this.state;
  }

  private emit(): void {
    this.onChange?.();
  }

  private fail(where: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.state.error = `${where}: ${message}`;
    this.emit();
  }

  // ---- hosting ------------------------------------------------------------

  async startHosting(matchName = 'LAN Party'): Promise<void> {
    try {
      this.installEvents();
      await this.transport.host(matchName);
      this.state.role = 'hosting';
      this.state.roster = emptyRoster();
      // The host takes a seat and is always ready: it plays, it is not a
      // dedicated server.
      this.nextSlotId = 0;
      const me = this.seat(clampName(this.localName), true);
      this.state.mySlotId = me.slotId;
      this.emit();
    } catch (err) {
      this.fail('host', err);
    }
  }

  /**
   * The team a new player starts on.
   *
   * Free-for-all: the lowest team nobody holds, so a joiner is never silently
   * on a stranger's side -- including after someone has left, which is the case
   * that broke when this counted slots. Teams: the smaller of the two sides.
   */
  private defaultTeam(): number {
    const slots = this.state.roster.slots;
    if (this.state.roster.mode === MODE_TEAMS) {
      const onZero = slots.filter((s) => s.team === 0).length;
      return onZero <= slots.length - onZero ? 0 : 1;
    }
    const taken = new Set(slots.map((s) => s.team));
    let team = 0;
    while (taken.has(team)) team++;
    return team;
  }

  private seat(name: string, isHost: boolean): WireLobbySlot {
    const slot: WireLobbySlot = {
      slotId: this.nextSlotId++,
      name,
      team: this.defaultTeam(),
      ready: isHost,
      isHost,
    };
    this.state.roster.slots.push(slot);
    return slot;
  }

  private broadcastRoster(): void {
    const w = new Writer();
    writeRoster(w, this.state.roster);
    this.transport.broadcast(w.finish(), true);
  }

  private welcome(peerId: PeerId, slotId: number): void {
    const w = new Writer();
    writeLobbyWelcome(w, slotId);
    this.transport.send(peerId, w.finish(), true);
  }

  // ---- joining ------------------------------------------------------------

  async startBrowsing(): Promise<void> {
    try {
      this.installEvents();
      this.state.role = 'browsing';
      this.state.hosts = [];
      this.emit();
      await this.transport.discover();
    } catch (err) {
      this.fail('discover', err);
    }
  }

  async join(peerId: PeerId): Promise<void> {
    try {
      this.installEvents();
      await this.transport.join(peerId);
      this.hostId = peerId;
      const w = new Writer();
      writeLobbyJoin(w, clampName(this.localName));
      this.transport.send(peerId, w.finish(), true);
      this.state.role = 'joined';
      this.emit();
    } catch (err) {
      this.fail('join', err);
    }
  }

  // ---- player actions -----------------------------------------------------

  /** Request a team change. A client changes nothing locally -- see the top. */
  setTeam(team: number): void {
    if (this.state.role === 'hosting') {
      const slot = this.slotById(this.state.mySlotId);
      if (slot) {
        slot.team = team;
        this.broadcastRoster();
        this.emit();
      }
      return;
    }
    this.request((w) => writeLobbySetTeam(w, team));
  }

  setReady(ready: boolean): void {
    if (this.state.role === 'hosting') {
      const slot = this.slotById(this.state.mySlotId);
      if (slot) {
        slot.ready = ready;
        this.broadcastRoster();
        this.emit();
      }
      return;
    }
    this.request((w) => writeLobbySetReady(w, ready));
  }

  private request(build: (w: Writer) => void): void {
    if (this.hostId === null) return;
    const w = new Writer();
    build(w);
    this.transport.send(this.hostId, w.finish(), true);
  }

  /** Host only. */
  setMode(mode: number): void {
    if (this.state.role !== 'hosting') return;
    this.state.roster.mode = mode;
    // Reassign everyone so the label means something the moment it is chosen:
    // alternating sides for teams, one team each for free-for-all.
    this.state.roster.slots.forEach((s, i) => {
      s.team = mode === MODE_TEAMS ? i % 2 : i;
    });
    this.broadcastRoster();
    this.emit();
  }

  /** Host only. */
  setMap(mapId: number): void {
    if (this.state.role !== 'hosting') return;
    this.state.roster.mapId = mapId;
    this.broadcastRoster();
    this.emit();
  }

  canStart(): boolean {
    const s = this.state;
    return s.role === 'hosting' && s.roster.slots.length >= 2 && s.roster.slots.every((x) => x.ready);
  }

  /** Host only: peer id for a seated slot, for handing players to a match. */
  peerForSlot(slotId: number): PeerId | undefined {
    return this.peerBySlot.get(slotId);
  }

  slotById(slotId: number): WireLobbySlot | undefined {
    return this.state.roster.slots.find((s) => s.slotId === slotId);
  }

  // ---- transport plumbing -------------------------------------------------

  private installEvents(): void {
    this.transport.setEvents({
      onPeerJoin: (peer: Peer) => this.handlePeerJoin(peer),
      onPeerLeave: (peerId: PeerId) => this.handlePeerLeave(peerId),
      onPacket: (from: PeerId, data: Uint8Array) => {
        this.handlePacket(from, data);
      },
      onError: (err: Error) => this.fail('transport', err),
    });
  }

  private handlePeerJoin(peer: Peer): void {
    if (this.state.role === 'browsing') {
      if (!this.state.hosts.some((h) => h.id === peer.id)) {
        this.state.hosts.push({ id: peer.id, name: peer.name });
        this.emit();
      }
    }
    // Hosting: a peer connecting is not yet a seated player. Seating waits for
    // their Join, which carries the name.
  }

  /** Public so a match's own peer-leave handler can forward departures here. */
  handlePeerLeave(peerId: PeerId): void {
    if (this.state.role === 'browsing') {
      this.state.hosts = this.state.hosts.filter((h) => h.id !== peerId);
      this.emit();
      return;
    }
    const slotId = this.slotIdForPeer(peerId);
    if (slotId === undefined) return;
    this.peerBySlot.delete(slotId);
    this.state.roster.slots = this.state.roster.slots.filter((s) => s.slotId !== slotId);
    this.broadcastRoster();
    this.emit();
  }

  /**
   * Handle one packet if it is a lobby message. Returns whether it was, so a
   * dispatcher shared with a match knows whether to pass it on.
   */
  handlePacket(from: PeerId, data: Uint8Array): boolean {
    if (data.length < 2 || data[0] !== LOBBY_MSG) return false;
    const r = new Reader(data);
    r.u8(); // LOBBY_MSG
    const op = r.u8();
    try {
      if (this.state.role === 'hosting') this.handleHostSide(from, op, r);
      else this.handleClientSide(op, r);
    } catch (err) {
      // A truncated or malformed lobby packet must not take the screen down.
      this.fail('lobby packet', err);
    }
    return true;
  }

  private handleHostSide(from: PeerId, op: number, r: Reader): void {
    if (op === LobbyOp.Join) {
      const name = r.str();
      // A second Join from a seated peer is a retry, not a second player.
      const existing = this.slotIdForPeer(from);
      if (existing !== undefined) {
        this.welcome(from, existing);
        return;
      }
      if (this.state.roster.slots.length >= MAX_LOBBY_SLOTS) return;
      const slot = this.seat(clampName(name) || 'Player', false);
      this.peerBySlot.set(slot.slotId, from);
      this.welcome(from, slot.slotId);
      this.broadcastRoster();
      this.emit();
      return;
    }

    const slotId = this.slotIdForPeer(from);
    if (slotId === undefined) return;
    const slot = this.slotById(slotId);
    if (!slot) return;

    if (op === LobbyOp.SetTeam) slot.team = r.u8();
    else if (op === LobbyOp.SetReady) slot.ready = r.u8() !== 0;
    else return;
    this.broadcastRoster();
    this.emit();
  }

  private handleClientSide(op: number, r: Reader): void {
    if (op === LobbyOp.Roster) {
      this.state.roster = readRoster(r);
      this.emit();
    } else if (op === LobbyOp.Welcome) {
      this.state.mySlotId = r.u8();
      this.emit();
    }
  }

  private slotIdForPeer(peerId: PeerId): number | undefined {
    for (const [slotId, id] of this.peerBySlot) {
      if (id === peerId) return slotId;
    }
    return undefined;
  }

  async close(): Promise<void> {
    try {
      await this.transport.close();
    } catch {
      // Closing a transport that never opened is not worth surfacing.
    }
    this.state = idleState();
    this.peerBySlot.clear();
    this.hostId = null;
    this.emit();
  }
}
