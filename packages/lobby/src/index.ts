/**
 * The lobby's wire protocol: who is seated, on which team, and who is ready.
 *
 * Platform code. Every game shares one lobby, so these messages belong to no
 * game. They moved here from the tanks protocol byte for byte -- same tag, same
 * opcodes, same layout -- so a tanks build from before the move and one from
 * after still understand each other's lobby.
 *
 * Like everything under packages/, this imports nothing from any game.
 */
import { Reader, Writer } from '@lan-party/net';

/**
 * The first byte of every lobby message.
 *
 * Games share the same channel, so a game's own message types must never use
 * this value. Tanks reserves it as `MsgType.Lobby`.
 */
export const LOBBY_MSG = 5;

/**
 * Lobby.
 *
 * This is where "teams, one or many" is actually decided. The simulation keys
 * every hostility decision off `team`, so a lobby that can put eight players on
 * eight teams gets free-for-all, and one that puts them on two gets 4v4, with
 * no other code aware of the difference. Nothing here caps the team count below
 * the roster size on purpose.
 *
 * The host is authoritative. Clients *request* a team and the host answers with
 * a roster; a client never assumes its own request took. Two players tapping
 * the same team at once is normal, and the alternative -- optimistic local
 * team changes -- shows two phones disagreeing about who is on which side right
 * up until the match starts.
 */
export enum LobbyOp {
  /** Host -> everyone, reliable. The authoritative roster and settings. */
  Roster = 1,
  /** Host -> one client, reliable. Tells it which slot is itself. */
  Welcome = 2,
  /** Client -> host. "Seat me, this is my name." */
  Join = 3,
  /** Client -> host. "Put me on this team." */
  SetTeam = 4,
  /** Client -> host. Ready toggle. */
  SetReady = 5,
}

/**
 * Roster ceiling: the most seats the lobby can hand out, for any game.
 *
 * This is the encoding's ceiling, not a promise that every game can seat this
 * many. A game takes its real limit from its own rules -- tanks, for one, takes
 * it from the arena's spawn points, and refuses a joiner when none is free
 * rather than stacking two tanks on one square.
 *
 * History worth keeping: this was set when it was also the tanks snapshot
 * budget's limit, and the tanks maps were later given eight spawns each so
 * that seats and spawns match exactly. Tanks' own test that no map carries
 * more spawns than this stays with the tanks tests.
 */
export const MAX_LOBBY_SLOTS = 8;

/**
 * Name length in *bytes*, not characters.
 *
 * Phone names are full of emoji, and one emoji is four bytes. Truncating on a
 * byte count without respecting codepoint boundaries produces a partial
 * sequence that TextDecoder renders as a replacement character, so a player
 * named with an emoji would see their name mangled on every other phone.
 */
export const MAX_NAME_BYTES = 16;

/**
 * Truncate to `MAX_NAME_BYTES` without splitting a UTF-8 codepoint.
 *
 * Continuation bytes are 10xxxxxx, so walking back off them lands on the start
 * of the character that would have been cut in half.
 */
export function clampName(name: string): string {
  const enc = new TextEncoder().encode(name);
  if (enc.length <= MAX_NAME_BYTES) return name;
  let end = MAX_NAME_BYTES;
  while (end > 0 && (enc[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(enc.subarray(0, end));
}

export interface WireLobbySlot {
  /** Stable id assigned by the host. Survives other players leaving. */
  slotId: number;
  name: string;
  team: number;
  ready: boolean;
  isHost: boolean;
}

export interface WireRoster {
  /**
   * The game's map, and below it the match settings. These predate the move
   * out of tanks and are game-specific; they stay in the same place on the
   * wire so older tanks builds keep reading the roster.
   */
  mapId: number;
  /** 0 = free-for-all, 1 = teams. Labelling only; the sim does not branch. */
  mode: number;
  roundsToWin: number;
  slots: WireLobbySlot[];
}

export function writeRoster(w: Writer, r: WireRoster): void {
  // `readRoster` refuses a count over the limit, and until this guard existed
  // the writer would happily produce one -- so seating a ninth player made a
  // packet every client throws on. The host is the only place with enough
  // context to say what went wrong; on the receiving side it arrives as a
  // roster that stops updating, which is what a lobby looks like when it has
  // simply hung.
  if (r.slots.length > MAX_LOBBY_SLOTS) {
    throw new Error(
      `roster has ${r.slots.length} slots, over the ${MAX_LOBBY_SLOTS} limit -- readRoster refuses this, so every client would drop it`,
    );
  }
  w.u8(LOBBY_MSG).u8(LobbyOp.Roster);
  w.u8(r.mapId).u8(r.mode).u8(r.roundsToWin);
  w.u8(r.slots.length);
  for (const s of r.slots) {
    w.u8(s.slotId).u8(s.team);
    w.u8((s.ready ? 1 : 0) | (s.isHost ? 2 : 0));
    w.str(clampName(s.name));
  }
}

export function readRoster(r: Reader): WireRoster {
  const mapId = r.u8();
  const mode = r.u8();
  const roundsToWin = r.u8();
  const count = r.u8();
  if (count > MAX_LOBBY_SLOTS) {
    // A corrupt count would otherwise drive a loop that reads garbage until it
    // runs off the end. Refusing early names the real problem.
    throw new Error(`roster claims ${count} slots, over the ${MAX_LOBBY_SLOTS} limit`);
  }
  const slots: WireLobbySlot[] = [];
  for (let i = 0; i < count; i++) {
    const slotId = r.u8();
    const team = r.u8();
    const flags = r.u8();
    slots.push({
      slotId,
      team,
      ready: (flags & 1) !== 0,
      isHost: (flags & 2) !== 0,
      name: r.str(),
    });
  }
  return { mapId, mode, roundsToWin, slots };
}

/** Client -> host requests, and the host's welcome. All tiny. */
export function writeLobbyJoin(w: Writer, name: string): void {
  w.u8(LOBBY_MSG).u8(LobbyOp.Join).str(clampName(name));
}

export function writeLobbySetTeam(w: Writer, team: number): void {
  w.u8(LOBBY_MSG).u8(LobbyOp.SetTeam).u8(team);
}

export function writeLobbySetReady(w: Writer, ready: boolean): void {
  w.u8(LOBBY_MSG).u8(LobbyOp.SetReady).u8(ready ? 1 : 0);
}

export function writeLobbyWelcome(w: Writer, slotId: number): void {
  w.u8(LOBBY_MSG).u8(LobbyOp.Welcome).u8(slotId);
}
