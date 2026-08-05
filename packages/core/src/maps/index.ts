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

/** The single-player campaign, in escalating difficulty order. */
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
      '#.1.%......gg......%...#',
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
      '#....t.....#......t....#',
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
