/**
 * How much radio does a match actually need?
 *
 * The sim benchmark answered "can the phone compute it". This answers the other
 * half: can the radio carry it, at the roster sizes the lobby offers. It exists
 * because the four-versus-eight seat question was about to be settled by
 * opinion, and the numbers turn out to point somewhere other than where the
 * worry was.
 *
 *     node tools/net-budget.mjs
 *
 * What the host sends is snapshots on a fixed clock plus events when they
 * happen. The snapshot carries tanks only -- 6 bytes each, 52 for a full
 * roster -- because a shell travels once as an 8-byte spawn and is then
 * simulated deterministically on every phone. Events are broadcast one write
 * each, and a broadcast is one write per client: BLE notifications are
 * per-connection, there is no broadcast on the radio.
 *
 * The event rate is the part that cannot be derived on paper, so this runs the
 * real sim with everyone holding the trigger and counts what MatchHost would
 * have queued. Sample run on a CI-class box:
 *
 *      2 players    3.9 shell/s   host out    21 w/s @18    21 w/s @178   in   60 w/s
 *      8 players   17.7 shell/s   host out   533 w/s @18   323 w/s @178   in  420 w/s
 *
 * Read per connection, eight players at the BLE floor is ~76 writes/s out and
 * 60 in -- under one packet per connection event at any sane interval. So
 * bandwidth is not what caps the roster. Seven concurrent GATT links is; see
 * the topology notes in net/ble.ts.
 *
 * As in sim-bench.mjs, everyone is revived every tick. Without that a
 * free-for-all with the trigger held wipes out in a couple of hundred ticks and
 * the rest of the run measures an empty arena firing nothing.
 */
import {
  createWorld,
  step,
  loadArena,
  VERSUS_MAPS,
  emptyInput,
  EventKind,
  TICK_HZ,
  MINE_ARM_TICKS,
  MAX_LOBBY_SLOTS,
  SNAPSHOT_HZ,
  BLE_SAFE_MTU,
  FRAME_HEADER_BYTES,
  Writer,
  writeSnapshot,
} from '@tanks/core';

const FLOOR = 20 - FRAME_HEADER_BYTES; // what a stack that never negotiates gives us
const GOOD = BLE_SAFE_MTU - FRAME_HEADER_BYTES;
const SECONDS = 60;
const TICKS = TICK_HZ * SECONDS;

const snapshotBytes = (tanks) => {
  const w = new Writer(256);
  writeSnapshot(
    w,
    1234,
    Array.from({ length: tanks }, (_, i) => ({
      id: i,
      x: 5.5 + i,
      y: 4.5,
      bodyAngle: 1,
      turretAngle: 2,
      alive: true,
    })),
  );
  return w.finish().length;
};

function measure(players) {
  const arena = loadArena(VERSUS_MAPS[0]);
  const world = createWorld({
    arena,
    seed: 11,
    players: Array.from({ length: players }, (_, i) => ({ team: i, spawnIndex: i })),
  });

  const inputs = new Map();
  const drive = (t) => ({
    ...emptyInput(),
    moveX: Math.sin(t / 17),
    moveY: Math.cos(t / 23),
    aimX: Math.cos(t / 13),
    aimY: Math.sin(t / 11),
    fire: true,
    layMine: t % 40 === 0,
  });
  const revive = () => {
    for (const t of world.tanks) t.alive = true;
  };

  let shells = 0;
  let mines = 0;
  let evts = 0;
  for (let t = 0; t < TICKS; t++) {
    revive();
    for (const tank of world.tanks) inputs.set(tank.id, drive(t));
    step(world, inputs);
    // The same tests MatchHost uses to decide what to queue, so this counts
    // what would actually have gone out rather than what is merely alive.
    for (const s of world.shells) if (s.bornTick === world.tick - 1) shells++;
    for (const m of world.mines) if (m.armTick - MINE_ARM_TICKS === world.tick - 1) mines++;
    for (const e of world.events) {
      if (e.kind === EventKind.TankDestroyed || e.kind === EventKind.BlockDestroyed) evts++;
    }
  }

  const clients = players - 1; // the host is one of the players
  const evPerSec = (shells + mines + evts) / SECONDS;
  const snap = snapshotBytes(players);
  // Events are 6-8 bytes, one fragment at any MTU; only the snapshot fragments.
  const out = (frags) => (frags * SNAPSHOT_HZ + evPerSec) * clients;

  console.log(
    `${String(players).padStart(2)} players  ${String(snap).padStart(3)}B snap  ` +
      `${(shells / SECONDS).toFixed(1).padStart(5)} shell/s  ` +
      `${(mines / SECONDS).toFixed(1).padStart(4)} mine/s  ` +
      `${(evts / SECONDS).toFixed(1).padStart(5)} kill+block/s  |  ` +
      `out ${out(Math.ceil(snap / FLOOR)).toFixed(0).padStart(4)} w/s @${FLOOR}  ` +
      `${out(Math.ceil(snap / GOOD)).toFixed(0).padStart(4)} w/s @${GOOD}  |  ` +
      `in ${String(TICK_HZ * clients).padStart(4)} w/s`,
  );
  return { clients, floorOut: out(Math.ceil(snap / FLOOR)) };
}

console.log(
  `snapshots ${SNAPSHOT_HZ}Hz, inputs ${TICK_HZ}Hz, ${SECONDS}s with everyone firing\n`,
);
let full;
for (const n of [2, 4, 6, MAX_LOBBY_SLOTS]) full = measure(n);
// Derived from the run that just happened, not pasted from one that did.
console.log(`
Per connection at the floor, a full roster is about ${Math.round(full.floorOut / full.clients)} writes/s out
and ${TICK_HZ} in, across ${full.clients} concurrent links. Bandwidth is not the limit on
roster size -- the number of those links is. See net/ble.ts.`);
