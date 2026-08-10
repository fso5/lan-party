/**
 * Chicken Nugget Simulator, as a lobby game.
 *
 * Vendored from fso5/chicken-nugget-simulator. Be a chicken nugget, hop in all
 * seven sauces, don't get eaten.
 *
 * ## Why this one is worth having
 *
 * It is single-player, it predates the contract, and it was written with no
 * knowledge that a lobby would ever exist. That makes it the honest test of
 * whether `packages/sdk` actually abstracts anything: if a game this unrelated
 * to Tanks plugs in without the contract bending, the boundary is real. If it
 * needed special cases, the contract was really just "Tanks, generalised."
 *
 * It needed none. It ignores `channel` entirely, which is the point — the lobby
 * does not force multiplayer concerns onto a game that has none.
 *
 * ## Why an iframe
 *
 * The original runs `requestAnimationFrame(loop)` at module scope and never
 * stops. There is no teardown to call, and `destroy()` is not optional in the
 * contract — a lobby that cannot reclaim the screen after a round is a lobby
 * you have to reload to leave.
 *
 * Rewriting 779 lines of working, playable game to add a lifecycle would risk
 * breaking the thing whose only virtue is that it already works. An iframe
 * gives a correct `destroy()` for free: removing the element takes its rAF
 * loop, its listeners and its globals with it. It also means the vendored file
 * stays byte-identical to upstream, so re-vendoring is a copy rather than a
 * merge.
 *
 * The cost is that the game cannot reach `channel` directly. For a
 * single-player game that is no cost at all, and if a future version wants a
 * shared leaderboard, `postMessage` is the seam and it is already where it
 * needs to be.
 */

import type {
  GameChannel,
  GameInstance,
  GameModule,
  MatchSetup,
  RoundResult,
} from '@lan-party/sdk';

// Injected at build time by build.mjs, which inlines the vendored HTML so the
// game ships inside the bundle rather than as a second fetch. A lobby served
// off a phone's hotspot should not depend on a second round trip.
declare const NUGGETS_HTML: string;

export const nuggets: GameModule = {
  info: {
    id: 'nuggets',
    name: 'Chicken Nugget Simulator',
    blurb: 'Be a nugget. Hop in all seven sauces. Do not get eaten.',
    minPlayers: 1,
    maxPlayers: 8,
    // Teams mean nothing here, so the lobby should not offer the control.
    // Offering a choice that changes nothing is worse than offering none.
    supportsTeams: false,
    maps: ['The Kitchen'],
  },

  mount(
    container: HTMLElement,
    _setup: MatchSetup,
    _channel: GameChannel,
    onRoundOver: (result: RoundResult) => void,
  ): GameInstance {
    const frame = document.createElement('iframe');
    frame.style.cssText =
      'width:100%;height:100%;border:0;display:block;background:#0d1117';
    // Scripts yes, same-origin no: the game needs to run but has no business
    // reaching the lobby's DOM or storage.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = NUGGETS_HTML;
    container.appendChild(frame);

    // The vendored game does not report scores yet. When it does, it will post
    // them; until then this listener is inert rather than absent, so wiring it
    // up later is a change in one file.
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const data = e.data as { type?: string; score?: number } | null;
      if (data?.type === 'nuggets:gameover') {
        onRoundOver({ winner: -1, scores: [] });
      }
    };
    window.addEventListener('message', onMessage);

    return {
      destroy() {
        window.removeEventListener('message', onMessage);
        // Removing the iframe is the teardown: its rAF loop, its listeners and
        // its globals all go with it.
        frame.remove();
      },
    };
  },
};

export default nuggets;
