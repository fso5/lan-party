/**
 * The game <-> lobby contract.
 *
 * This is the whole point of the restructure: the lobby owns everything social
 * — who is here, what side they are on, who is ready, what the score is,
 * getting back to the lobby afterwards — and a game owns nothing but the game.
 *
 * If this boundary is right, Tanks plugs in unmodified and so does a second
 * game with entirely different rules. If it is wrong, every game ends up
 * reaching into lobby concerns and we are back where we started.
 *
 * ## Two rules that shape everything here
 *
 * **A game never learns how its bytes travel.** It is handed a `GameChannel`
 * and uses it. Today that is a WebSocket on someone's hotspot. It could be
 * anything later, and no game should need touching if it changes.
 *
 * **A game never decides who is playing.** It receives a settled roster. It
 * does not seat players, assign teams, or decide when to start — those are all
 * lobby concerns, and a game that duplicates them will disagree with the lobby
 * eventually.
 *
 * Session A: protocol has been your lane throughout and I offered you this
 * design. This is a proposal to argue with, not a decision — override any of it.
 */

/** Stable id for a seated player. Survives other players leaving. */
export type PlayerId = number;

export interface LobbyPlayer {
  id: PlayerId;
  name: string;
  /**
   * Which side. The lobby guarantees this is set; it does not guarantee what it
   * means. Everyone on a distinct team is free-for-all, and a game that only
   * reads `team` gets both modes for free without branching.
   */
  team: number;
  isHost: boolean;
}

/**
 * How a game sends and receives. Deliberately tiny: bytes in, bytes out.
 *
 * `reliable` selects delivery guarantees. Anything a client cannot re-derive —
 * a spawn, a round result — must be reliable. Continuous state should not be:
 * a dropped position update is replaced by a newer one, and retransmitting a
 * stale one wastes budget to deliver something already wrong.
 */
export interface GameChannel {
  readonly localId: PlayerId;
  readonly isHost: boolean;
  /** Largest payload `send` accepts. Treat as a hard ceiling. */
  readonly maxPayload: number;

  send(to: PlayerId, data: Uint8Array, reliable: boolean): void;
  broadcast(data: Uint8Array, reliable: boolean): void;
  onMessage(cb: (from: PlayerId, data: Uint8Array) => void): void;
  /** A player vanished mid-match. The lobby has already removed them. */
  onPlayerLeft(cb: (id: PlayerId) => void): void;
}

/** Everything a game needs to start a match, settled by the lobby. */
export interface MatchSetup {
  players: LobbyPlayer[];
  /**
   * Shared seed. Every client must produce identical results from it, which is
   * what lets a game send an event once and have everyone simulate the
   * consequences rather than streaming them.
   */
  seed: number;
  /** Which of the game's own maps/variants, by index into `GameInfo.maps`. */
  mapIndex: number;
  roundsToWin: number;
}

export interface RoundResult {
  /** Winning team, or -1 for a draw. Draws are common and not an error state. */
  winner: number;
  /** Optional per-player detail for the lobby scoreboard. */
  scores?: Array<{ id: PlayerId; score: number }>;
}

/**
 * What a game tells the lobby about itself, before anyone has joined.
 *
 * The lobby uses this to render the game picker and to police the roster — it
 * will not let a match start that this game cannot run.
 */
export interface GameInfo {
  id: string;
  name: string;
  /** One line, shown on the game picker. */
  blurb: string;
  minPlayers: number;
  maxPlayers: number;
  /**
   * Whether the lobby should offer a team selector at all. A game where teams
   * are meaningless should not show the control -- offering a choice that
   * changes nothing is worse than offering none.
   */
  supportsTeams: boolean;
  /** Human-readable map names; the lobby shows these and sends back an index. */
  maps: string[];
}

/**
 * A mounted, running game.
 *
 * `mount` is handed a DOM element and owns everything inside it. The lobby does
 * not draw the game and the game does not draw the lobby.
 */
export interface GameInstance {
  /** Tear down: cancel timers, release the canvas, drop listeners. */
  destroy(): void;
}

export interface GameModule {
  readonly info: GameInfo;

  /**
   * Start a match. Called on every participant, host and clients alike, with
   * the same `setup`.
   *
   * `onRoundOver` is how a game hands control back. Only the host's call is
   * authoritative — the lobby ignores it from clients, because a client that
   * derived the result independently would disagree the moment its prediction
   * was corrected.
   */
  mount(
    container: HTMLElement,
    setup: MatchSetup,
    channel: GameChannel,
    onRoundOver: (result: RoundResult) => void,
  ): GameInstance;
}

/**
 * Games register themselves here. The lobby reads the registry to build its
 * picker, so adding a game is one import and one call, with no lobby changes.
 */
const registry = new Map<string, GameModule>();

export function registerGame(game: GameModule): void {
  if (registry.has(game.info.id)) {
    throw new Error(`duplicate game id: ${game.info.id}`);
  }
  registry.set(game.info.id, game);
}

export function getGame(id: string): GameModule | undefined {
  return registry.get(id);
}

export function allGames(): GameModule[] {
  return [...registry.values()];
}

/**
 * Can this roster start this game? Returns why not, or null if it can.
 *
 * Lives here rather than in the lobby so the rule and the numbers it reads sit
 * in one place; the lobby renders whatever string comes back.
 */
export function whyCannotStart(
  game: GameInfo,
  playerCount: number,
): string | null {
  if (playerCount < game.minPlayers) {
    const need = game.minPlayers - playerCount;
    return `${game.name} needs ${game.minPlayers} players — ${need} more to go`;
  }
  if (playerCount > game.maxPlayers) {
    return `${game.name} takes at most ${game.maxPlayers} players`;
  }
  return null;
}
