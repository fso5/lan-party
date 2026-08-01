# Tanks!

A mobile clone of *Tanks!* from Wii Play, with local multiplayer over Bluetooth.

## The goal

Phones in a room, playing each other with **no internet and no WiFi**. One phone
hosts and the others find it over Bluetooth. Free-for-all or teams — several
teams, not just two. A choice of maps. Nobody signs into anything.

Where that stands:

| | |
|---|---|
| The game — ricochets, mines, destructible terrain, enemy AI, 8 maps | done |
| On a phone — iPhone via the web app, Android via the APK | done |
| Match rules — rounds, scoring, free-for-all and several teams | done, live in the host |
| Bluetooth — transport, framing, native GATT on both platforms | written, **never run on a radio** |
| Lobby — the wire protocol for rosters, teams and round results | done |
| Lobby — the screen you tap to host, join and pick a side | **not built** |

The honest summary: everything under the multiplayer is built and tested against
a simulated link, and none of it has moved a byte between two real phones. The
lobby is the missing piece that would let it.

Phone held sideways. Left stick drives, right stick aims the turret independently,
buttons fire shells and lay mines. Shells ricochet off walls and kill in one hit —
including your own shell, including you.

## Play it

**iPhone / any browser — https://fso5.github.io/tanks-mobile/**

Open it, then Share → Add to Home Screen. A service worker caches the whole app
on first load, so it runs with the network gone. This is the only route onto an
iPhone: release assets are served `Content-Disposition: attachment`, so Safari
downloads `tanks.html` rather than running it, and HTML opened from the iOS
Files app goes through Quick Look where JavaScript is unreliable.

The build it was made from is shown in the footer, so you can tell at a glance
whether a phone is running a cached copy.

## Install it

**Android — [download the APK](https://github.com/fso5/tanks-mobile/releases/latest)**

Open that link on the phone, tap the `.apk`, allow "install unknown apps" when
the browser asks. Built in CI on every push, so there is no laptop anywhere in
the delivery path.

Every push builds a new APK and attaches it, alongside `tanks.html` — the same
game as a single 108 KB file that opens in any browser and runs offline. Both
are generated from source by CI, so neither can go stale.

Tap **Bluetooth** in the app to host or join a match with nearby phones — no
internet, no WiFi, no pairing. The native module compiles and ships in the APK,
but it has **not been verified on hardware**: that needs two devices in hand.
Everything above the radio is tested (76 tests, including a full match over the
BLE code path against a simulated link).

One caveat, because "the module ships in the APK" reads as more than it is:
nothing in the JavaScript currently imports the adapter, so Metro drops it and
the radio is present but unreachable in the build on the release right now. The
lobby is what connects them.

### iPhone

There is no way to put a native iOS app on an iPhone without either a paid
Apple Developer account or a Mac — that is Apple's constraint, not ours. So:

- **Today, free:** open `tanks.html` in Safari. Single-player and 2P work.
  No Bluetooth — iOS Safari has no Web Bluetooth at all, and never has.
- **Bluetooth on iPhone:** needs an Apple Developer account ($99/yr). With one,
  `eas build --platform ios --profile preview` builds in the cloud and installs
  via TestFlight, with no laptop involved. `eas.json` is configured for it.

## Playing it with no laptop and no internet

`packages/proto/dist/tanks-proto.html` is one self-contained file with zero
external references — no CDN, no fonts, no server. Put it on a phone once and it
works offline forever.

- **Android** — save it, open Chrome, go to `file:///sdcard/Download/tanks.html`
  (or tap it in Files and choose Chrome).
- **iOS** — save to Files, tap to open. If JavaScript doesn't run in the Quick
  Look preview, share it into a browser app that reads local files.

Tap **2P** for two people on one phone: left thumb is blue, right thumb is red,
drag to steer and tap to fire. Each seat gets one stick that both drives and
aims — two thumbs can't work four sticks. That does cost the thing that makes
the real game feel right, driving one way while shooting another, so couch play
is the compromise mode, not the scheme the phone app should ship.

Two *separate* phones can't play each other in a browser with no laptop: there's
nothing to run the host on, and Web Bluetooth doesn't exist on iOS at all. That
needs the native app, which is what `BleTransport` is for.

## Build it

```
npm install
npm test  --workspace @tanks/core      # 76 tests, headless
npm test  --workspace @tanks/app       # 28 tests
npm run build --workspace @tanks/proto # -> packages/proto/dist/tanks-proto.html
npm run smoke --workspace @tanks/proto # drives the built page in a real browser
npm run serve --workspace @tanks/proto  # single-player, serve on your LAN
npm run mp    --workspace @tanks/proto  # multiplayer: host + serve on your LAN
```

`mp` runs the authoritative host in Node and serves the page; open the printed
URL on two phones and they play each other. Everything above the transport is
what will run over Bluetooth -- same `MatchHost`, same `MatchClient`, same wire
format, same 180-byte payload ceiling -- so moving to a radio is a transport
swap and nothing else.

`serve` prints a `http://192.168.x.x:8080` URL. Put your phone on the same WiFi,
open it, and you get the touch build: left thumb drives, right thumb drags to
aim and taps to fire. It rebuilds on every request, so changing code and pulling
to refresh is the whole loop.

`packages/proto` is a throwaway browser harness, not the shipping app. It exists
to answer the one question the test suite cannot: *do the ricochets feel right?*
Press <kbd>T</kbd> to trace your current aim through the real shell physics,
bounces included — the fastest way to confirm by eye that the ricochet code does
what the tests claim.

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
  rules.ts       rounds, scoring, free-for-all and teams
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

1. ~~Deterministic sim core~~ — done
2. ~~Netcode: host/client, prediction, rollback reconciliation~~ — done
3. ~~`LoopbackTransport` with a simulated lossy link~~ — done
4. ~~WebSocket transport + two-device multiplayer over WiFi~~ — done
5. ~~`BleTransport` — framing, fragmentation, host/client over GATT~~ — done,
   pending a real radio
6. ~~Android app + cloud APK build, installable with no laptop~~ — done
7. ~~Native BLE module — advertising and the GATT server~~ — done, compiles and
   ships in the APK, unverified on hardware
8. ~~Match rules — rounds, scoring, free-for-all and multi-team~~ — done, and
   the host scores live rounds over the wire
9. ~~Lobby protocol — rosters, team changes, round results~~ — done
10. **Lobby screen** — host, discover, pick a team and a map, start. The one
   thing standing between the tested stack and two phones actually playing:
   nothing in JS imports the radio until this exists.
11. Host migration
12. Mods: more maps, map editor

76 tests passing. Steps 5 and 6 are deliberately ordered: debugging prediction
and reconciliation over UDP is tractable; debugging it *simultaneously* with
debugging BLE is not.

### Measured over the BLE transport

Full match stack — `MatchHost`, `MatchClient`, prediction, reconciliation — run
over the BLE framing path against a simulated radio, 30s each:

| Link | avg drift | max drift | reconciles | over the air |
|---|---|---|---|---|
| Typical (45ms, 3% loss), 2 tanks | 0.010 tiles | 0.124 | 41 | 851 B/s |
| Poor (90ms, 10% loss), 2 tanks | 0.028 tiles | 0.287 | 77 | 790 B/s |
| Typical, 4 tanks | 0.010 tiles | 0.124 | 41 | 1027 B/s |

Against a 2–8 KB/s BLE ceiling. Even on the poor link the worst disagreement is
0.29 tiles, well under a tank's 0.76-tile width, and no resync was needed.

Host is the GATT **peripheral** and advertises; clients are centrals. That's the
inverse of the intuitive arrangement, and it's the only one that works
cross-platform — see the header comment in `net/ble.ts`. Reliability maps onto
BLE's own two modes (indication vs notification) rather than a hand-rolled ack
scheme, so a snapshot loss costs nothing and a shell spawn cannot be dropped.

### Measured netcode behaviour

Host and client driven for 30s of virtual time over simulated links, tracking
the client's predicted position against the host's authoritative one:

| Link | avg drift | max drift | reconciles | bandwidth |
|---|---|---|---|---|
| Perfect | 0.005 tiles | 0.010 | 0 / 450 snapshots | 727 B/s |
| WiFi (6ms, 0.1% loss) | 0.005 tiles | 0.010 | 0 / 449 | 726 B/s |
| **Bluetooth (45ms, 30ms jitter, 3% loss)** | **0.015 tiles** | **0.302** | **44 / 433** | **705 B/s** |
| Degraded BLE (90ms, 60ms jitter, 10% loss) | 0.042 tiles | 0.429 | 80 / 404 | 655 B/s |

A tank is 0.76 tiles across, so even on a deliberately bad link the worst
disagreement is around half a tank width, and it's corrected in the past rather
than as a visible snap. The 0.005 floor on a perfect link is snapshot
quantisation (1/128 tile), not drift — and the client deliberately does *not*
reconcile against it, which is why the reconcile count is 0 there rather than
15/second of wasted CPU.
