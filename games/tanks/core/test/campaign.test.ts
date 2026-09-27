import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadArena, MISSIONS } from '../src/maps/index.js';
import { TankKind } from '../src/types.js';

const NAMES: Record<number, string> = {
  [TankKind.Brown]: 'Brown',
  [TankKind.Grey]: 'Grey',
  [TankKind.Teal]: 'Teal',
  [TankKind.Yellow]: 'Yellow',
  [TankKind.Green]: 'Green',
  [TankKind.Black]: 'Black',
};

/**
 * The campaign lineups, as measured.
 *
 * Sorted, because what matters is which tanks a mission fields and not the
 * order they happen to appear in the ASCII.
 */
const LINEUPS: Record<string, string[]> = {
  'First Contact': ['Brown', 'Brown', 'Brown'],
  'Cork Yard': ['Brown', 'Brown', 'Grey'],
  'The Gallery': ['Green', 'Grey', 'Grey'],
  Chasm: ['Green', 'Grey', 'Yellow'],
  'Last Stand': ['Black', 'Green', 'Grey'],
};

/**
 * This is a change-detector, deliberately.
 *
 * The property worth having is that the campaign gets harder as it goes, and
 * that is not assertable here at any honest price: measuring it takes ~960
 * simulated matches -- two stand-ins, five missions, 96 seeds, up to 150s of
 * game time each -- and lives in tools/campaign-curve.mjs. A cheap proxy in its
 * place (rank the kinds by tools/tank-balance.mjs and assert the ranks do not
 * fall) would assert something that is not the property and can disagree with
 * it, which is worse than asserting nothing.
 *
 * So this pins the rosters that were measured, and its whole job is to make an
 * edit to a mission lineup fail until somebody re-runs the tool and updates
 * both this table and the one in src/maps/index.ts. The curve took two tanks to
 * fix and six failed candidates to understand; it should not be possible to
 * undo that by retyping a letter in a map.
 *
 * Geometry is not pinned -- only who is in the fight. Moving a wall is a level
 * edit and this should not stand in its way, though it moves these numbers too.
 */
test('the campaign fields the lineups the difficulty curve was measured with', () => {
  assert.deepEqual(
    MISSIONS.map((m) => m.name),
    Object.keys(LINEUPS),
    'a mission was added, removed or renamed; re-run tools/campaign-curve.mjs',
  );

  for (const m of MISSIONS) {
    const got = loadArena(m)
      .enemies.map((e) => NAMES[e.kind] ?? `kind ${e.kind}`)
      .sort();
    assert.deepEqual(
      got,
      [...LINEUPS[m.name]].sort(),
      `"${m.name}" now fields ${got.join(' + ')} rather than ` +
        `${LINEUPS[m.name].join(' + ')}. That changes the difficulty curve. ` +
        `Re-run tools/campaign-curve.mjs at 96 seeds and update this table and ` +
        `the one in src/maps/index.ts, or put the lineup back.`,
    );
  }
});

/**
 * The stand-in measurement is only meaningful against tanks that fight back,
 * and a Player-kind tank gets no AI at all -- `makeTank` attaches one only when
 * `kind !== TankKind.Player`. A Player smuggled into a mission roster would be
 * a parked target dressed as an enemy, and the curve above would silently
 * describe a different game. That mistake has already been made once, in the
 * first version of tools/campaign-curve.mjs, which read 0% on every mission
 * including the tutorial because its *stand-in* was Player-kind.
 */
test('every campaign enemy is a kind that gets an AI', () => {
  for (const m of MISSIONS) {
    for (const e of loadArena(m).enemies) {
      assert.notEqual(
        e.kind,
        TankKind.Player,
        `"${m.name}" fields a Player-kind enemy, which never moves or fires`,
      );
      assert.ok(NAMES[e.kind], `"${m.name}" fields unknown tank kind ${e.kind}`);
    }
  }
});
