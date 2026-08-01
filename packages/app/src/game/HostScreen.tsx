/**
 * Hosting a match over WiFi.
 *
 * The flow this screen exists to make possible, with no internet and no Apple
 * Developer account anywhere in it:
 *
 *   1. This phone turns on its hotspot and taps Host.
 *   2. It shows a URL.
 *   3. Everyone else joins the hotspot and opens that URL in a browser.
 *   4. This phone taps Start.
 *
 * Step 3 is why the page is served from here rather than opened from the web:
 * an HTTPS page may not open a `ws://` connection to a local IP, so the client
 * has to come from the same http origin as the socket.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  LanHost,
  MatchHost,
  TankKind,
  VERSUS_MAPS,
  Writer,
  createWorld,
  loadArena,
  writeMatchStart,
} from '@tanks/core';

import { canHostOverWifi } from '../../modules/tanks-lan';
import { NativeTcpServer } from '../net/tcpServer';
import { base64ToBytes } from '../net/base64';
import { GAME_PAGE_BASE64 } from '../net/gamePage';
import { GameScreen } from './GameScreen';

type Phase = 'idle' | 'starting' | 'waiting' | 'playing';

export function HostScreen({ onBack }: { onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [players, setPlayers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const lanRef = useRef<LanHost | null>(null);
  const matchRef = useRef<MatchHost | null>(null);

  // Stop listening when the screen goes away. A listener left running holds the
  // port, so coming back to this screen would fail to bind and look broken.
  useEffect(() => {
    return () => {
      void lanRef.current?.stop();
      lanRef.current = null;
    };
  }, []);

  const startHosting = useCallback(async () => {
    setError(null);
    if (!canHostOverWifi()) {
      setError('Hosting needs the Android app. On iPhone, join a host instead.');
      return;
    }

    setPhase('starting');
    try {
      const lan = new LanHost(new NativeTcpServer(), {
        page: base64ToBytes(GAME_PAGE_BASE64),
      });
      lan.onPlayerJoin = () => setPlayers(lan.playerIds.slice());
      lan.onPlayerLeave = () => setPlayers(lan.playerIds.slice());
      lan.onError = (where, message) => setError(`${where}: ${message}`);

      await lan.start();
      lanRef.current = lan;
      setUrl(lan.joinUrl);
      setPhase('waiting');

      if (!lan.joinUrl) {
        // Bound fine, but the phone has no local address -- almost always the
        // hotspot being off. Naming that is far more useful than a blank space
        // where the URL should be.
        setError('No network address yet. Turn on your hotspot, then tap Host again.');
      }
    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /**
   * Build the roster for a round from whoever is connected right now.
   *
   * Recomputed every round rather than fixed at match start, which is what
   * seats a late joiner. Somebody who opens the URL mid-round is otherwise a
   * connected peer that nothing ever gives a tank to -- their browser sits on
   * an open socket showing nothing, for ever.
   *
   * Seat 0 is this phone. Everyone else follows in `playerIds` order, and that
   * order is the wire contract: tank ids come from creation order, so the same
   * roster has to be rebuilt identically on every device.
   */
  const buildRoster = useCallback((round: number) => {
    const lan = lanRef.current;
    const map = VERSUS_MAPS[0];
    const arena = loadArena(map);
    const peers = lan ? lan.playerIds.slice() : [];

    // Everyone on their own team is free-for-all. The simulation only keys off
    // team, so seating two players on one team would be 2v2 with nothing else
    // changing -- that is what the lobby will choose once it exists.
    const seats = 1 + peers.length;
    const players = Array.from({ length: seats }, (_, i) => ({ team: i, spawnIndex: i }));

    // Fill unclaimed spawns with bots so a two-phone match is not an empty map.
    const botKinds = [TankKind.Grey, TankKind.Teal, TankKind.Green];
    const bots: { kind: number; team: number; spawnIndex: number }[] = [];
    for (let s = seats; s < arena.spawns.length; s++) {
      bots.push({ kind: botKinds[(s - seats) % botKinds.length], team: 90 + s, spawnIndex: s });
    }

    // A fresh seed per round, so round two is not a replay of round one with
    // the same bot decisions from the same positions.
    const seed = 0x7a5 + round * 7919 + seats * 31;
    return { map, arena, peers, players, bots, seed };
  }, []);

  /** Seat every connected phone in the current world and tell it which tank. */
  const seatAll = useCallback(
    (host: MatchHost, roster: ReturnType<typeof buildRoster>) => {
      const lan = lanRef.current;
      if (!lan) return;

      host.localTankId = host.world.tanks[0].id;

      roster.peers.forEach((peerId, i) => {
        const tankId = i + 1; // Players are created first, in this order.
        host.addClient(peerId, tankId);
        const w = new Writer(64);
        writeMatchStart(w, {
          mapId: roster.map.id,
          seed: roster.seed,
          // The client starts its clock ahead of ours from this. A client level
          // with the host can never apply a snapshot, and silently never
          // reconciles.
          hostTick: host.world.tick,
          yourTankId: tankId,
          players: roster.players,
          bots: roster.bots,
        });
        lan.transport.send(peerId, w.finish(), true);
      });
    },
    [buildRoster],
  );

  const startMatch = useCallback(() => {
    const lan = lanRef.current;
    if (!lan) return;

    const roster = buildRoster(1);
    const world = createWorld({
      arena: roster.arena,
      seed: roster.seed,
      players: roster.players,
      bots: roster.bots,
    });

    const host = new MatchHost(world, lan.transport);

    // Without this a won round takes the whole match: the intermission ends
    // with the previous round's corpses still lying there, so the next tick
    // decides the "new" round for the same team, and a best-of-three finishes
    // in seconds with nobody playing.
    const pending = { roster };
    host.roundBuilder = (round) => {
      pending.roster = buildRoster(round);
      return createWorld({
        arena: pending.roster.arena,
        seed: pending.roster.seed,
        players: pending.roster.players,
        bots: pending.roster.bots,
      });
    };
    host.onRoundStart = () => {
      // Reseat from scratch: the roster is rebuilt each round, so a phone that
      // joined mid-round now has a tank, and everyone's tank id may have moved.
      for (const peerId of lan.playerIds) host.removeClient(peerId);
      seatAll(host, pending.roster);
    };

    seatAll(host, roster);
    matchRef.current = host;
    setPhase('playing');
  }, [buildRoster, seatAll]);

  if (phase === 'playing' && matchRef.current) {
    return <GameScreen session={matchRef.current} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.title}>Host over WiFi</Text>

      {phase === 'idle' && (
        <>
          <Text style={styles.body}>
            Turn on your phone&apos;s hotspot first. It does not need internet — everyone just
            needs to be on the same network.
          </Text>
          <TouchableOpacity style={styles.button} onPress={startHosting}>
            <Text style={styles.buttonText}>Start hosting</Text>
          </TouchableOpacity>
        </>
      )}

      {phase === 'starting' && <ActivityIndicator size="large" />}

      {phase === 'waiting' && (
        <>
          <Text style={styles.label}>Others join the hotspot, then open this in a browser:</Text>
          <Text selectable style={styles.url}>
            {url ?? '—'}
          </Text>

          <Text style={styles.label}>
            {players.length === 0
              ? 'Nobody has joined yet.'
              : `${players.length} joined${players.length > 3 ? '' : ''}`}
          </Text>

          <TouchableOpacity
            style={[styles.button, players.length === 0 && styles.buttonMuted]}
            onPress={startMatch}
          >
            <Text style={styles.buttonText}>
              {players.length === 0 ? 'Start anyway (vs bots)' : 'Start match'}
            </Text>
          </TouchableOpacity>
        </>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity style={styles.back} onPress={onBack}>
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, gap: 16, flexGrow: 1, justifyContent: 'center', backgroundColor: '#16140F' },
  title: { fontSize: 28, fontWeight: '700', color: '#EDE5D3' },
  body: { fontSize: 16, lineHeight: 22, color: '#9A9080' },
  label: { fontSize: 14, color: '#9A9080' },
  // Big and monospaced because someone is reading this out to a room, or
  // squinting at it while typing on another phone.
  url: {
    fontSize: 24,
    fontFamily: 'monospace',
    color: '#EDE5D3',
    paddingVertical: 12,
    letterSpacing: 1,
  },
  button: { backgroundColor: '#2f6fd0', padding: 16, borderRadius: 10, alignItems: 'center' },
  buttonMuted: { backgroundColor: '#4a4438' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: '600' },
  error: { color: '#d05f5f', fontSize: 15, lineHeight: 20 },
  back: { padding: 12, alignItems: 'center' },
  backText: { color: '#9A9080', fontSize: 16 },
});
