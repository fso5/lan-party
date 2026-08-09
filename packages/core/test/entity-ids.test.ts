/**
 * An entity id is one byte on the wire, and that byte is a margin being spent.
 *
 * `world.nextEntityId` is a counter that never resets. `host.ts` sends
 * `shell.id % MAX_WIRE_ENTITY_IDS`, so every 256th spawn hands out a number
 * some earlier entity already had. That is not a bug on its own -- the byte
 * only has to tell apart the entities that are alive at the same moment -- but
 * it is a budget, and nothing had ever measured how much of it the game uses.
 *
 * ## What spending it costs
 *
 * Not a duplicate on screen, which is what makes it worth a test. `client.ts`
 * replays spawns after a rewind and skips any whose id is already live:
 *
 *     if (this.world.shells.some((x) => x.id === s.entity.id)) continue;
 *
 * That line exists so a rewind cannot double a shell it already has. Give two
 * *different* live shells the same low byte and it does the opposite: the
 * second one is never put back. It stays lethal on the host and invisible on
 * the phone -- and since the rewind depth follows the link's latency, it would
 * be a shell that vanishes over Bluetooth and behaves over loopback. Nothing
 * about that points at an id space.
 *
 * ## The measurement
 *
 * Ten minutes of the fullest match the seat cap allows, every tank driving and
 * holding the trigger, laying mines on a timer, revived every tick so the match
 * cannot end early and leave this measuring an empty arena.
 *
 * What it reports is the worst *churn*: how many ids the world handed out
 * during the lifetime of any single live entity. A wrap needs 256 of them.
 * Measured at the cap, the worst shell sees 172 and the worst mine 117 -- so
 * two thirds of the budget is already spent, which is the reason this is a test
 * rather than a note.
 *
 * The bound is at 224, not at 256. 256 is where it breaks; asserting there
 * means the first run to fail is a run that was already broken. Leaving the
 * last eighth as a warning strip costs nothing today -- the measurement is 172,
 * a long way below either number -- and buys an argument about a shell profile
 * before it becomes an argument about whose phone is wrong.
 *
 * Mines and shells draw from the same counter, so they are measured together
 * rather than as two separate budgets.
 *
 * ## What actually moves the number, and what does not
 *
 * `MAX_SHELLS_PER_TANK` is the lever. Raising it 5 -> 12 takes the worst churn
 * from 172 to 313 and this test red -- with real collisions, not just a bound
 * crossed. Peak live shells is exactly the cap times the seat count (40 at 5,
 * 95 at 12), so the arena saturates and the id space empties at whatever rate
 * that saturated set turns over.
 *
 * `SHELL_MAX_LIFETIME_TICKS` is not a lever, which is worth knowing before
 * someone reaches for it as the safe knob. Raising it 12s -> 30s changes
 * nothing at all -- 12431 ids and a worst churn of 172, identical to the digit.
 * Shells in a full arena die on impact, or out of bounces, a long way inside
 * twelve seconds; the expiry branch in `sim.ts` barely runs. An identical
 * measurement usually means the mutation never took, so it was worth chasing:
 * here it took, and the constant genuinely does not bind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TICK_HZ } from '../src/tuning.js';
import { emptyInput } from '../src/types.js';
import { createWorld, step } from '../src/sim.js';
import { loadArena, VERSUS_MAPS } from '../src/maps/index.js';
import { MAX_LOBBY_SLOTS, MAX_WIRE_ENTITY_IDS } from '../src/net/protocol.js';

/** Where the bound sits, below the 256 at which entities actually collide. */
const CHURN_BUDGET = 224;

const MINUTES = 10;
const TICKS = TICK_HZ * 60 * MINUTES;

interface Churn {
  worstShell: number;
  worstMine: number;
  peakShells: number;
  peakMines: number;
  idsAllocated: number;
  liveCollisions: number;
  fullyAliveTicks: number;
}

function measure(): Churn {
  const arena = loadArena(VERSUS_MAPS[0]);
  const world = createWorld({
    arena,
    seed: 7,
    players: Array.from({ length: MAX_LOBBY_SLOTS }, (_, i) => ({
      team: i,
      spawnIndex: i % arena.spawns.length,
    })),
    bots: [],
  });

  // Everyone driving, aiming and firing. The same shape sim-bench uses, for the
  // same reason: an idle world spawns nothing and would report a churn of zero
  // as a comfortable margin.
  const drive = (t: number) => ({
    ...emptyInput(),
    moveX: Math.sin(t / 17),
    moveY: Math.cos(t / 23),
    aimX: Math.cos(t / 13),
    aimY: Math.sin(t / 11),
    fire: true,
    layMine: t % 40 === 0,
  });

  /** id -> ids allocated in the world at the moment it was first seen alive. */
  const bornAt = new Map<number, number>();
  const out: Churn = {
    worstShell: 0,
    worstMine: 0,
    peakShells: 0,
    peakMines: 0,
    idsAllocated: 0,
    liveCollisions: 0,
    fullyAliveTicks: 0,
  };

  for (let t = 0; t < TICKS; t++) {
    // Eight tanks with the trigger held wipe each other out in seconds, and a
    // dead arena fires nothing. Revived every tick, as in perf.test.ts.
    for (const tank of world.tanks) tank.alive = true;
    if (world.tanks.length === MAX_LOBBY_SLOTS) out.fullyAliveTicks++;

    const inputs = new Map<number, ReturnType<typeof drive>>();
    for (const tank of world.tanks) inputs.set(tank.id, drive(t + tank.id));
    step(world, inputs);

    const allocated = world.nextEntityId;
    for (const group of [world.shells, world.mines]) {
      const byLowByte = new Map<number, number>();
      for (const e of group) {
        if (!bornAt.has(e.id)) bornAt.set(e.id, allocated);
        const low = e.id % MAX_WIRE_ENTITY_IDS;
        // The failure itself, not a proxy for it: two live entities that the
        // wire would name identically.
        if (byLowByte.get(low) !== undefined && byLowByte.get(low) !== e.id) {
          out.liveCollisions++;
        }
        byLowByte.set(low, e.id);
      }
    }
    for (const s of world.shells) {
      out.worstShell = Math.max(out.worstShell, allocated - bornAt.get(s.id)!);
    }
    for (const m of world.mines) {
      out.worstMine = Math.max(out.worstMine, allocated - bornAt.get(m.id)!);
    }
    out.peakShells = Math.max(out.peakShells, world.shells.length);
    out.peakMines = Math.max(out.peakMines, world.mines.length);

    // Forget the dead, or this grows to one entry per spawn for ten minutes.
    if (bornAt.size > 4000) {
      const live = new Set([...world.shells, ...world.mines].map((e) => e.id));
      for (const id of [...bornAt.keys()]) if (!live.has(id)) bornAt.delete(id);
    }
  }

  out.idsAllocated = world.nextEntityId;
  return out;
}

test('a live entity never outlives its slot in the one-byte id space', () => {
  const c = measure();

  /*
   * The vacuity guards, first and separately.
   *
   * Every number below is a maximum over things this loop found, and a run that
   * found nothing reports zero -- which reads exactly like an enormous margin.
   * A match that ended early, an arena that seated two tanks, or a `fire` input
   * that stopped reaching the simulation would each produce a confident green
   * run about nothing at all.
   */
  assert.equal(
    c.fullyAliveTicks,
    TICKS,
    `the roster was not ${MAX_LOBBY_SLOTS} tanks for all ${TICKS} ticks, so this measured a smaller match than the game allows`,
  );
  assert.ok(
    c.peakShells > 10,
    `only ${c.peakShells} shells were ever live at once -- nobody was firing, and a churn of ${c.worstShell} means nothing`,
  );
  assert.ok(
    c.peakMines > 4,
    `only ${c.peakMines} mines were ever live at once -- nobody was laying them`,
  );
  assert.ok(
    c.idsAllocated > MAX_WIRE_ENTITY_IDS * 4,
    `only ${c.idsAllocated} ids were handed out in ${MINUTES} minutes, which never even wraps the byte once`,
  );

  console.log(
    `  entity ids: ${c.idsAllocated} allocated, peak ${c.peakShells} shells / ${c.peakMines} mines live, ` +
      `worst churn ${c.worstShell} (shell) ${c.worstMine} (mine) of ${MAX_WIRE_ENTITY_IDS}`,
  );

  // The thing itself. If this ever trips, the two above have already ruled out
  // the measurement having gone wrong instead.
  assert.equal(
    c.liveCollisions,
    0,
    `${c.liveCollisions} times two live entities shared a wire id; client.ts's replaySpawns drops the second`,
  );

  const worst = Math.max(c.worstShell, c.worstMine);
  assert.ok(
    worst <= CHURN_BUDGET,
    `a live entity saw ${worst} ids handed out during its lifetime, against ${MAX_WIRE_ENTITY_IDS} available ` +
      `(the bound is ${CHURN_BUDGET}, deliberately below the ${MAX_WIRE_ENTITY_IDS} where it breaks). ` +
      `Two live shells sharing a low byte means the second is never replayed after a rewind: lethal on the ` +
      `host, invisible on the phone. Widening shellId and mineId to u16 costs one byte per spawn event ` +
      `and a PROTOCOL_VERSION bump.`,
  );
});
