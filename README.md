# Tanks!

A mobile clone of *Tanks!* from Wii Play, with local multiplayer over Bluetooth.

Phone held sideways. Left stick drives, right stick aims the turret independently,
buttons fire shells and lay mines. Shells ricochet off walls and kill in one hit —
including your own shell, including you.

## Status

The deterministic simulation core is built and tested. There is no renderer and
no Bluetooth transport yet; see the roadmap.

```
npm install
npm test --workspace @tanks/core
```

## Why the core is built the way it is

### Everything hinges on determinism

Bluetooth LE gives roughly 2–8 KB/s of usable throughput once several links are
up, with a 15ms minimum connection interval on iOS. You cannot stream the
position of every shell to every player inside that budget.

So we don't. A shell's entire future — every bounce, for as long as it lives —
is fully determined by its spawn position, angle, and bounce count. The host
sends a single **10-byte spawn event** and every client simulates the trajectory
locally using the identical physics code. A shell that ricochets around the
arena for eight seconds costs ten bytes, once.

That only works if every device computes the *same* trajectory. Which leads to
the constraint that shapes the whole codebase:

> **`Math.sin`, `Math.cos`, and `Math.atan2` are not specified by ECMAScript.**
> Engines choose their own implementations and disagree in the last bits.

iOS runs JavaScriptCore, Android runs Hermes. A one-ulp difference in a launch
angle compounds across bounces until a shell hits on one phone and misses on the
other. So `src/math.ts` implements its own `dsin`/`dcos`/`datan2` from
operations IEEE-754 *does* specify (`+ - * /` and `sqrt`), accurate to ~1e-11
and — the part that matters — identical everywhere.

A test asserts this stays true: it monkey-patches `Math.sin` and friends, runs a
600-tick match, and fails if the simulation touched any of them.

### Bandwidth budget

| Traffic | Size | Rate | Throughput |
|---|---|---|---|
| Client → host input | 8 bytes | 60 Hz | 480 B/s up |
| Host → client snapshot (8 tanks) | 52 bytes | 15 Hz | 780 B/s down |
| Shell spawn | 10 bytes | per shot | negligible |

A full 8-tank snapshot is 52 bytes, which fits in a single BLE write on iOS
(~180 byte safe payload). Tested in `determinism.test.ts`.

### Topology

Star, not mesh. bitchat-style TTL flood relay is excellent for text and wrong
for a twitch game — each hop adds 30–200ms. Relay is used for lobby discovery
and chat; gameplay goes host↔client directly.

### The AI aims by test-firing

Rather than solving mirror-reflection geometry on a grid with destructible tiles
and holes, each enemy sweeps 96 candidate angles and traces every one through
the *real* shell physics, keeping whichever path passes closest to its target.

This costs more than closed-form geometry and buys three things: every shot the
AI takes is provably achievable; bank shots and shots over holes need no special
case; and when a block is destroyed the AI adapts on its next think tick for
free. Measured at 60–80µs/tick with all AI active — about 0.4% of the 60Hz
budget on V8.

Per-type reaction delay (`tuning.ts`) is the fairness knob: it's what gives you
time to dodge, and what makes the late-game tanks frightening.

## Layout

```
packages/core/src/
  math.ts        deterministic trig + seeded PRNG
  types.ts       world state (plain data, trivially serializable)
  tuning.ts      all gameplay constants, incl. the enemy roster
  map.ts         tile grid, ASCII map parser, line-of-sight
  physics.ts     tank sliding, shell ricochet (DDA), swept collision
  sim.ts         the tick function: (state, inputs) -> state
  ai.ts          enemy behaviour and the shot solver
  maps/          5 campaign missions, 3 versus arenas
  net/
    transport.ts  BLE / LAN / loopback interface
    protocol.ts   binary wire format
```

Maps are authored as ASCII so a level reads as a picture in source:

```
'#....%....%%%%....%....#'    # wall   % destructible block
'#.........%..%.........#'    O hole   1-4 team spawns
'#....#....%..%....#....#'    b g t y n k  enemy tanks
```

## Roadmap

1. ~~Deterministic sim core~~ — done, 20 tests passing
2. Renderer + touch controls (React Native + Skia), single-player campaign
3. `LoopbackTransport`, then `LanTransport` (UDP) — validate netcode over a
   forgiving link before fighting BLE
4. `BleTransport` — the cross-platform one; iOS peripheral role is the hard part
5. Lobby, teams, host migration
6. Mods: multi-team, more maps, map editor

Steps 3 and 4 are deliberately ordered. Debugging prediction and reconciliation
over UDP is tractable; debugging it over BLE at the same time as debugging BLE
is not.
