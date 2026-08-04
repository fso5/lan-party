# Tanks!

A mobile clone of *Tanks!* from Wii Play, with local multiplayer over Bluetooth.

## The goal

Phones in a room, playing each other with **no internet**. One phone hosts and
the others join it — over Bluetooth, or over a hotspot with no internet behind
it. Free-for-all or teams — several teams, not just two. A choice of maps.
Nobody signs into anything.

Two routes because iPhones are the constraint: Bluetooth needs a native app,
and a native app on an iPhone needs a paid Apple account. A hotspot needs
neither — an iPhone joins in Safari.

Where that stands:

| | |
|---|---|
| The game — ricochets, mines, destructible terrain, enemy AI, 8 maps | done |
| On a phone — iPhone via the web app, Android via the APK | done |
| Match rules — rounds, scoring, free-for-all and several teams | done, live in the host |
| Bluetooth — transport, framing, native GATT on both platforms | written, **never run on a radio** |
| WiFi hotspot — host on Android, join from any browser, no Apple account | built, **never run on a real hotspot** |
| Lobby — wire protocol, and the browser side of picking a team | done, tested end to end |
| Host screen — tap to host, shows the URL to read out | built |
| **Picking teams in the app** | **not built** — the host still seats everyone free-for-all |

The honest summary: the whole path is now built, and it has been driven end to
end — a real socket, a real WebSocket client, a real match — but only ever on
one machine. **It has never run on an actual hotspot between two actual
phones.** That is the one thing left to find out.

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
game as a single file, around 160 KB, that opens in any browser and runs
offline. Both are generated from source by CI, so neither can go stale.

## Playing together

No internet, no accounts, nothing installed on the iPhones.

**On the Android phone:**

1. Turn on Personal Hotspot. It does **not** need internet — it is only being
   used as a local network.
2. Open Tanks! → **Host over WiFi** → **Start hosting**.
3. It shows a URL, something like `http://192.168.43.1:8080`. Read it out.
   (If something else on the phone already has port 8080, it quietly picks
   another one and shows that instead — so read out whatever is on screen
   rather than what you expect.)

**On every other phone, iPhone included:**

4. Join that hotspot in WiFi settings.
5. Open a browser and type the URL. The game loads from the host phone.

**Back on the host:** it counts who has joined. Tap **Start match**.

### If it goes wrong

The game tries to say what to do rather than leaving you guessing:

- **"reconnecting"** — the connection dropped, which on a phone is routine: the
  screen sleeping is enough. It retries on its own, and retries immediately when
  you look at the page again. If it keeps failing for a few seconds it will say
  to check you are still on the host's hotspot.
- **"solo" on the installed web app** — that one cannot join a match, and not
  for a fixable reason: it is served over HTTPS, and an HTTPS page is not
  allowed to open a connection to a local address. Open the `http://` address
  the host phone shows instead.
- **Nothing loads at all** — first check the URL is the hotspot's address and
  not the phone's mobile-data one. A tethering phone holds both, and until
  recently the host could read out the wrong one, which fails in exactly this
  way. It should now start `192.168.`; if the host shows no URL at all it will
  say so and ask you to turn the hotspot on. Failing that, some Android
  hotspots isolate connected devices from each other, which is a hotspot
  setting rather than the game.
- **An iPhone drops the network** — iOS sometimes abandons a WiFi network with
  no internet. Telling it to stay connected fixes it.

**Tap the build number** in the corner for connection stats: ticks, snapshots
applied and stale, reconciles, resyncs, position error. Zero snapshots means
nothing is arriving from the host; a climbing stale count means it is arriving
too late to use. It was on the `G` key, which is no help on a phone — and a
phone with no laptop next to it is exactly the situation where the numbers
matter.

Bluetooth is a separate route that needs no hotspot at all. The native module
compiles and ships in the APK, but nothing in the JavaScript imports it yet, so
it is present and unreachable in the current build — and it has never been run
on a radio. WiFi is the path that works today.

### iPhone, and why WiFi beats Bluetooth here

There is no way to put a native iOS app on an iPhone without either a paid
Apple Developer account or a Mac — Apple's constraint, not ours. iOS Safari
also has no Web Bluetooth, and never has. So an iPhone cannot run our
Bluetooth code by any free route.

It doesn't need to. **The requirement was never internet — it was no internet.**
A personal hotspot is a local network with no internet, and that is all this
game wants:

- One **Android** phone hosts. It serves the game page and runs the match.
- Everyone else — iPhones included — opens `http://<host-ip>:8080` in Safari.
  Nothing installed, no account, no App Store, no pairing.

The catch that shapes the design: an HTTPS page **cannot** open a `ws://`
connection to a local IP — browsers block it as mixed content. So the cached
PWA can't be the client, and the host phone has to serve the page as well as
host the match. That's why `net/websocket.ts` is an HTTP server and not just a
socket.

Bluetooth stays worth having — it needs no hotspot at all, and works
Android-to-Android today. It's the better answer when no iPhone is involved.

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

Two *separate* phones playing each other needs something to host the match, and
a browser cannot be that — it can only be a WebSocket client, never a server.
The Android app is the answer: it listens, so the iPhones can join it. That is
what `net/websocket.ts` is for, and it is why Bluetooth is not the only route.

## Build it

```
npm install
npm test  --workspace @tanks/core      # 177 tests, headless
npm test  --workspace @tanks/app       # 46 tests
npm run build --workspace @tanks/proto # -> packages/proto/dist/tanks-proto.html
npm run smoke --workspace @tanks/proto # drives the built page in a real browser
npm run mp:smoke    --workspace @tanks/proto  # two browsers against a real host
npm run lobby:smoke --workspace @tanks/proto  # the lobby, teams, and a round change
npm run pwa:check   --workspace @tanks/proto  # the installed app, with the network cut
npm run serve --workspace @tanks/proto  # single-player, serve on your LAN
npm run mp    --workspace @tanks/proto  # multiplayer: host + serve on your LAN
```

The browser runs are the only things that exercise the multiplayer client at
all — the scoreboard and the lobby are both invisible in solo play, so nothing
else can reach them. They run in CI on every change to the game or the core.

CI also unpacks the APK it just built and checks the JavaScript bundle inside
it still contains the native transport and core's netcode. Metro only bundles
what something imports, so a module nothing reaches from JavaScript is dropped
silently and the app ships without it while every other step stays green —
which is exactly the state the Bluetooth module is in. Note for anyone reading
that bundle by hand: Hermes stores ASCII strings one byte per character and
only uses UTF-16 for strings that need it, so `TanksLan` is found by a UTF-8
search and *not* by a UTF-16 one. Searching only UTF-16 for a module name
returns nothing whether or not the module ships.

### Checking that a test would fail

```
tools/mutate.sh <file> "<command>" "<old text>" "<new text>" ["label"]
```

Breaks something on purpose, runs the command, and puts the file back. Exit 0
means the mutation was caught and 1 means nothing covers it. The rest are
refusals rather than verdicts: 9 means the text was not found, 3 means the
command already fails without any mutation, and 4 means the command never reads
the file at all.

Those three are the whole reason this is a script rather than a one-liner, and
each was added after it had already produced a wrong answer.

**9** came first. Every mutation here started as a `perl -0pi -e s///`, and a
pattern that matched nothing failed silently — reporting that the code had
survived when nothing had been changed. Two map checks "survived" that way
before the miscounted pattern turned up.

**3** is the same disease pointing the other way. "Caught" is inferred from the
command failing, so a command that was already failing reports every mutation
as caught. A test path written relative to `packages/core` while standing in
the repo root does it, and one of those false positives was hiding a mutation
that had genuinely survived. So the command is run once against the pristine
file first, and a verdict is refused unless that passes.

**4** is the nastiest, because it fabricates the alarming answer rather than
the reassuring one. `npx tsx --test test/*.test.ts` from the repo root matches
no files, so node prints `tests 0` and exits 0 — and every mutation under it
comes back SURVIVED. Four of them did, across three files, before the pattern
was obvious; three of the four are caught when the command is pointed at the
right directory. A false *survived* is worse than a false *caught*: it sends
you writing tests for behaviour that was already covered. So the file is also
replaced with something unparseable, and the command must fail — anything that
genuinely loads the file will.

One limit is not guarded. If the command builds, "caught" can mean the compiler
objected rather than a test failing; `noUnusedLocals` means deleting the sole
use of a constant is "caught" for reasons having nothing to do with coverage.
Prefer mutations that change a value over ones that remove a use.

A harness that cannot tell *the code survived* from *I changed nothing* — or
from *I ran nothing* — manufactures confidence in tests that do not have it,
which is worse than not checking.

Most tests in this repo have been through it. A few things genuinely are not
covered and are recorded as such rather than papered over — removing
`skipWaiting()` from the service worker changes nothing, because the worker
ends up controlling the reload anyway, and removing the cache-hit branch of
its fetch handler changes nothing either, because the page is one
self-contained file and the navigate fallback serves the only request there
is.

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
    websocket.ts  a WebSocket server, so a phone can host over WiFi
    lanhost.ts    serves the page and carries the match, on one port
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
10. ~~WebSocket server — so a phone can host over a hotspot and an iPhone can
    join in Safari with no Apple account~~ — done, dependency-free and
    interop-tested against a real client
11. ~~A listening socket in the app, and a screen to host from~~ — done. An
    Android phone hosts over its hotspot and serves the page it hosts.
12. **Teams and maps in the lobby.** Hosting currently seats everyone on their
    own team, which is free-for-all. The protocol carries teams already.
13. Host migration
14. Mods: more maps, map editor

119 tests passing. Steps 5 and 6 are deliberately ordered: debugging prediction
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
