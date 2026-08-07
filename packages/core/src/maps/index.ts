/**
 * Built-in arenas.
 *
 * Authored as ASCII so a level reads as a picture in source. Legend:
 *
 *   #  indestructible wall      .  floor
 *   %  destructible block       O  hole
 *   1-4  spawn point for team N (digit - 1)
 *   b g t y n k  enemy tanks: brown grey teal yellow greeN blacK
 *
 * Arenas are ~24x14 to suit a phone held sideways: a 16:9 screen at that grid
 * shows the whole arena with room for the HUD, which the original relies on --
 * you must be able to see every bank shot coming.
 */

import { Arena, parseArena } from '../map.js';

export interface Mission {
  id: number;
  name: string;
  rows: string[];
}

/**
 * The single-player campaign, in escalating difficulty order.
 *
 * That claim was false for a long time and is now measured. Win rate of a bot
 * stand-in in the player's seat, from tools/campaign-curve.mjs, 96 seeds a
 * mission -- lower is harder:
 *
 *              First Contact  Cork Yard  The Gallery  Chasm  Last Stand
 *     Grey               82%        23%          14%     8%          7%
 *     Teal               99%        60%          50%    26%         21%
 *
 * Both stand-ins descend at every step. Two are used rather than one because
 * neither is a player and each has its own quirks, so a conclusion is only
 * worth drawing where both agree.
 *
 * ## What it took, because the obvious repairs all fail
 *
 * As authored the curve read Grey [82 4 2 8 7], Teal [99 42 2 26 21]: steep out
 * of mission one, then wandering, with the finale easier than the middle.
 *
 * Reordering cannot fix that. The stand-ins disagree on which mission is
 * hardest, so no single order is monotone for both, and ordering by their
 * average puts The Gallery last -- making a mission called Last Stand the
 * fourth of five.
 *
 * Nor can hardening the finale, which is where the eye goes first. Six such
 * substitutions were measured and not one climbed, for a reason the baseline
 * gives away: both stand-ins were already at the floor by mission three, so
 * monotonicity would have required missions three, four and five to sit at 0%
 * for both -- a curve that climbs only by being unwinnable. Every candidate
 * that hardens the back half is pushing against that floor.
 *
 * The direction that works is the opposite one: soften the middle so there is
 * headroom above the finale. Two tanks change. Cork Yard drops one of its two
 * Greys for a Brown, and The Gallery drops both Teals -- the strongest pair in
 * the game, see tools/tank-balance.mjs -- for Greys. The geometry of every
 * arena is untouched.
 *
 * ## Before re-running this
 *
 * 24 seeds, which the tool defaults to, is too few to rank neighbouring
 * missions: Grey reads 67% on First Contact over 24 seeds and 82% over 96, and
 * the screening run that proposed this retune separated two missions by four
 * wins against three. Screen at 24, decide at 96.
 */
export const MISSIONS: Mission[] = [
  {
    id: 1,
    name: 'First Contact',
    rows: [
      '########################',
      '#......................#',
      '#......................#',
      '#....1............b....#',
      '#......................#',
      '#.......####...........#',
      '#.......#..#...........#',
      '#.......#..#...........#',
      '#.......####...........#',
      '#......................#',
      '#....b............b....#',
      '#......................#',
      '#......................#',
      '########################',
    ],
  },
  {
    id: 2,
    name: 'Cork Yard',
    rows: [
      '########################',
      '#......................#',
      '#...%%%%........%%%%...#',
      '#...%..............%...#',
      '#.1.%......bg......%...#',
      '#...%..............%...#',
      '#...%%%%........%%%%...#',
      '#......................#',
      '#....##..........##....#',
      '#....##..........##....#',
      '#..........b...........#',
      '#......................#',
      '#......................#',
      '########################',
    ],
  },
  {
    id: 3,
    name: 'The Gallery',
    rows: [
      '########################',
      '#..........#...........#',
      '#..1.......#.......n...#',
      '#..........#...........#',
      '#....%%%...#...%%%.....#',
      '#..........#...........#',
      '#......................#',
      '#..........#...........#',
      '#....%%%...#...%%%.....#',
      '#..........#...........#',
      '#....g.....#......g....#',
      '#..........#...........#',
      '#..........#...........#',
      '########################',
    ],
  },
  {
    id: 4,
    name: 'Chasm',
    rows: [
      '########################',
      '#......................#',
      '#..1...OOOOOOOO....y...#',
      '#......OOOOOOOO........#',
      '#......OOOOOOOO........#',
      '#......................#',
      '#..%%%..........%%%....#',
      '#..%%%..........%%%....#',
      '#......................#',
      '#......OOOOOOOO........#',
      '#..g...OOOOOOOO....n...#',
      '#......OOOOOOOO........#',
      '#......................#',
      '########################',
    ],
  },
  {
    id: 5,
    name: 'Last Stand',
    rows: [
      '########################',
      '#....#............#....#',
      '#.1..#....%%%%....#..k.#',
      '#....#....%..%....#....#',
      '#.........%..%.........#',
      '#....%....%%%%....%....#',
      '#....%............%....#',
      '#....%............%....#',
      '#....%....%%%%....%....#',
      '#.........%..%.........#',
      '#....#....%..%....#....#',
      '#.n..#....%%%%....#..g.#',
      '#....#............#....#',
      '########################',
    ],
  },
];

/**
 * Multiplayer arenas. Eight spawn points each, so the same map serves
 * free-for-all, 2v2, or any team split -- the lobby decides which spawn each
 * player takes and what team they are on, the map does not.
 *
 * Eight because that is what the lobby seats. With four, `createWorld` fell
 * back to `spawns[0]` for anyone past the fourth and the fifth through eighth
 * players all started life stacked on the first player's tile -- measured, not
 * feared: five tanks reading 2.50,1.50 and still reading it sixty ticks later,
 * because tanks do not collide with each other and so never pushed apart. In
 * free-for-all every one of them is an enemy of the others.
 *
 * 1-4 are the corners, as before. 5-8 are the midpoints of the four edges,
 * which is the symmetric complement and keeps the closest pair 5.1 tiles
 * apart. Each was snapped to the nearest tile a tank can actually occupy, so
 * Pillars' top and bottom starts sit one column off centre around its central
 * pillar.
 */
export const VERSUS_MAPS: Mission[] = [
  {
    id: 101,
    name: 'Crossfire',
    rows: [
      '########################',
      '#.1.........5........2.#',
      '#......................#',
      '#....%%%......%%%......#',
      '#....%..........%......#',
      '#....%..........%......#',
      '#..........##..........#',
      '#7.........##.........8#',
      '#......%..........%....#',
      '#......%..........%....#',
      '#......%%%......%%%....#',
      '#......................#',
      '#.3.........6........4.#',
      '########################',
    ],
  },
  {
    id: 102,
    name: 'Pillars',
    rows: [
      '########################',
      '#.1........##5.......2.#',
      '#..........##..........#',
      '#...##..........##.....#',
      '#...##..........##.....#',
      '#.......%%%%%%.........#',
      '#......................#',
      '#7....................8#',
      '#.......%%%%%%.........#',
      '#...##..........##.....#',
      '#...##..........##.....#',
      '#..........##..........#',
      '#.3........##6.......4.#',
      '########################',
    ],
  },
  {
    id: 103,
    name: 'The Moat',
    rows: [
      '########################',
      '#.1.........5........2.#',
      '#...OOOOOOOOOOOOOOOO...#',
      '#...O..............O...#',
      '#...O...%%%%%%%%...O...#',
      '#...O...%......%...O...#',
      '#.......%......%.......#',
      '#7......%......%......8#',
      '#...O...%%%%%%%%...O...#',
      '#...O..............O...#',
      '#...OOOOOOOOOOOOOOOO...#',
      '#......................#',
      '#.3.........6........4.#',
      '########################',
    ],
  },
];

const cache = new Map<string, Arena>();

/**
 * The parsed arena for a map, memoised by name.
 *
 * Shared and mutable: every caller gets the *same* object. That is fine for the
 * simulation, because `createWorld` clones it before a match can destroy
 * anything -- and only because of that. Anything else that writes to what this
 * returns corrupts the map for the rest of the process.
 *
 * Not hypothetical. A probe that substituted enemy kinds in place to compare
 * campaign lineups poisoned the cache on its first candidate, and every later
 * measurement -- including missions it never touched -- silently read the
 * mutated roster. The numbers looked plausible; three different substitutions
 * scoring identically is what gave it away.
 */
export function loadArena(m: Mission): Arena {
  const hit = cache.get(m.name);
  if (hit) return hit;
  const a = new Arena(parseArena(m.name, m.rows));
  cache.set(m.name, a);
  return a;
}

export function missionById(id: number): Mission | undefined {
  return MISSIONS.find((m) => m.id === id) ?? VERSUS_MAPS.find((m) => m.id === id);
}
