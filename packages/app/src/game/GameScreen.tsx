/**
 * Single-player game screen: sim + renderer + controls wired together.
 *
 * Ownership note — this is Session B's lane (packages/app). It only *reads*
 * @tanks/core: createWorld/step drive the sim, and world.tanks/shells/mines are
 * read to draw. Nothing here may change simulation behaviour.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import { Canvas, Circle, Group, Picture, Rect } from '@shopify/react-native-skia';
import type { SkPicture } from '@shopify/react-native-skia';
import {
  MISSIONS,
  TankKind,
  createWorld,
  loadArena,
  step,
  type TankInput,
  type WorldState,
} from '@tanks/core';

import { PALETTE, arenaHash, recordArena } from '../render/arena';
import { fitArena, sl, sx, sy } from '../render/viewport';
import {
  DEFAULT_CONFIG,
  TwinStickControls,
  type FireMode,
} from '../controls/twinstick';

const TANK_COLOURS: Record<TankKind, string> = {
  [TankKind.Player]: '#2f6fd0',
  [TankKind.Brown]: '#8a6033',
  [TankKind.Grey]: '#8b8b8b',
  [TankKind.Teal]: '#2aa39b',
  [TankKind.Yellow]: '#d4b02a',
  [TankKind.Green]: '#4f9d4f',
  [TankKind.Black]: '#2b2b2b',
};

export function GameScreen({ missionIndex = 0 }: { missionIndex?: number }) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [fireMode, setFireMode] = useState<FireMode>('button');

  // The sim is mutable state that changes 60x/second. Keeping it in a ref and
  // driving redraws with a frame counter avoids making React responsible for
  // reconciling the world, which it would do badly at this rate.
  const worldRef = useRef<WorldState | null>(null);
  const [, setFrame] = useState(0);

  const mission = MISSIONS[missionIndex] ?? MISSIONS[0];

  if (worldRef.current === null) {
    worldRef.current = createWorld({
      arena: loadArena(mission),
      seed: 0x5eed,
      players: [{ team: 0, spawnIndex: 0 }],
    });
  }
  const world = worldRef.current;

  const viewport = useMemo(
    () => fitArena(screenW, screenH, world.arena.width, world.arena.height),
    [screenW, screenH, world.arena.width, world.arena.height],
  );

  const controls = useMemo(
    () =>
      new TwinStickControls({
        ...DEFAULT_CONFIG,
        screenW,
        screenH,
        fireMode,
      }),
    // Rebuilt on resize/mode change; touch state is not worth preserving across
    // either, and carrying a stale stick origin through a resize looks broken.
    [screenW, screenH, fireMode],
  );

  // Static arena layer, re-recorded only when the tile grid actually changes.
  const pictureRef = useRef<SkPicture | null>(null);
  const hashRef = useRef<number>(-1);
  const viewportKey = `${viewport.scale}:${viewport.originX}:${viewport.originY}`;
  const lastViewportKey = useRef<string>('');

  const ensureArenaPicture = useCallback(() => {
    const h = arenaHash(world.arena);
    if (
      pictureRef.current === null ||
      h !== hashRef.current ||
      viewportKey !== lastViewportKey.current
    ) {
      pictureRef.current = recordArena(world.arena, viewport);
      hashRef.current = h;
      lastViewportKey.current = viewportKey;
    }
    return pictureRef.current;
  }, [world.arena, viewport, viewportKey]);

  ensureArenaPicture();

  // ---- the loop -----------------------------------------------------------

  const inputsRef = useRef<Map<number, TankInput>>(new Map());

  useEffect(() => {
    let raf = 0;
    let running = true;
    let acc = 0;
    let last = 0;
    const DT = 1 / 60;

    const frame = (now: number) => {
      if (!running) return;
      if (last === 0) last = now;
      let elapsed = (now - last) / 1000;
      last = now;
      if (!(elapsed > 0)) elapsed = 0;
      if (elapsed > 0.25) elapsed = 0.25;
      acc += elapsed;

      let ticks = 0;
      while (acc >= DT && ticks < 5) {
        // Sampled once per tick: sample() consumes the fire/mine pulses, so
        // sampling once per *frame* would drop shots on a 120Hz display and
        // double-fire on a slow one.
        const input = controls.sample();
        inputsRef.current.clear();
        const player = world.tanks.find((t) => t.kind === TankKind.Player);
        if (player) inputsRef.current.set(player.id, input);
        step(world, inputsRef.current);
        acc -= DT;
        ticks++;
      }
      if (acc >= DT) acc = 0;

      setFrame((f) => (f + 1) & 0xffff);
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [controls, world]);

  // ---- touch --------------------------------------------------------------

  const onStart = useCallback(
    (e: GestureResponderEvent) => {
      for (const t of e.nativeEvent.changedTouches) {
        controls.onPointerDown(
          Number(t.identifier),
          t.locationX ?? t.pageX,
          t.locationY ?? t.pageY,
        );
      }
    },
    [controls],
  );

  const onMove = useCallback(
    (e: GestureResponderEvent) => {
      for (const t of e.nativeEvent.touches) {
        controls.onPointerMove(
          Number(t.identifier),
          t.locationX ?? t.pageX,
          t.locationY ?? t.pageY,
        );
      }
    },
    [controls],
  );

  const onEnd = useCallback(
    (e: GestureResponderEvent) => {
      for (const t of e.nativeEvent.changedTouches) {
        controls.onPointerUp(Number(t.identifier));
      }
    },
    [controls],
  );

  // ---- draw ---------------------------------------------------------------

  const view = controls.view();
  const player = world.tanks.find((t) => t.kind === TankKind.Player);
  const alive = world.tanks.filter((t) => t.alive);

  return (
    <View style={styles.root}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Picture picture={ensureArenaPicture()!} />

        {world.mines.map((m) => (
          <Group key={`mine-${m.id}`}>
            <Circle
              cx={sx(viewport, m.x)}
              cy={sy(viewport, m.y)}
              r={sl(viewport, 0.22)}
              color="#3b3b3b"
            />
            <Circle
              cx={sx(viewport, m.x)}
              cy={sy(viewport, m.y)}
              r={sl(viewport, 0.1)}
              color={world.tick % 30 < 15 ? '#ff5b4a' : '#7a2f27'}
            />
          </Group>
        ))}

        {alive.map((t) => {
          const cx = sx(viewport, t.x);
          const cy = sy(viewport, t.y);
          const r = sl(viewport, 0.38);
          const colour = TANK_COLOURS[t.kind] ?? '#999';
          return (
            <Group key={`tank-${t.id}`}>
              <Group
                transform={[
                  { translateX: cx },
                  { translateY: cy },
                  { rotate: t.bodyAngle },
                ]}
              >
                <Rect
                  x={-r * 0.95}
                  y={-r * 0.8}
                  width={r * 1.9}
                  height={r * 1.6}
                  color={colour}
                />
                <Rect
                  x={-r * 0.95}
                  y={-r * 0.9}
                  width={r * 1.9}
                  height={r * 0.22}
                  color="#00000055"
                />
                <Rect
                  x={-r * 0.95}
                  y={r * 0.68}
                  width={r * 1.9}
                  height={r * 0.22}
                  color="#00000055"
                />
              </Group>
              <Group
                transform={[
                  { translateX: cx },
                  { translateY: cy },
                  { rotate: t.turretAngle },
                ]}
              >
                <Rect
                  x={0}
                  y={-r * 0.14}
                  width={r * 1.5}
                  height={r * 0.28}
                  color="#00000099"
                />
                <Circle cx={0} cy={0} r={r * 0.46} color={colour} />
                <Circle cx={0} cy={0} r={r * 0.46 * 0.55} color="#00000033" />
              </Group>
            </Group>
          );
        })}

        {world.shells.map((s) => (
          <Group key={`shell-${s.id}`}>
            <Circle
              cx={sx(viewport, s.x)}
              cy={sy(viewport, s.y)}
              r={sl(viewport, Math.max(s.radius, 0.07)) + 2}
              color="#ffffff40"
            />
            <Circle
              cx={sx(viewport, s.x)}
              cy={sy(viewport, s.y)}
              r={sl(viewport, Math.max(s.radius, 0.07))}
              color="#fff3c4"
            />
          </Group>
        ))}

        {view.drive.active && (
          <Group>
            <Circle
              cx={view.drive.ox}
              cy={view.drive.oy}
              r={controls.config.stickRadiusPx}
              color="#ffffff1a"
            />
            <Circle
              cx={view.drive.ox + view.drive.kx}
              cy={view.drive.oy + view.drive.ky}
              r={26}
              color="#ffffff59"
            />
          </Group>
        )}
        {view.aim.active && (
          <Group>
            <Circle
              cx={view.aim.ox}
              cy={view.aim.oy}
              r={controls.config.stickRadiusPx}
              color="#ffd9661a"
            />
            <Circle
              cx={view.aim.ox + view.aim.kx}
              cy={view.aim.oy + view.aim.ky}
              r={26}
              color="#ffd96688"
            />
          </Group>
        )}

        {fireMode === 'button' && (
          <Group>
            <Circle
              cx={controls.fireButton().x}
              cy={controls.fireButton().y}
              r={controls.fireButton().r}
              color={view.fireHeld ? '#ff6b5acc' : '#ff6b5a66'}
            />
            <Circle
              cx={controls.mineButton().x}
              cy={controls.mineButton().y}
              r={controls.mineButton().r}
              color={view.mineHeld ? '#ffd966cc' : '#ffd96666'}
            />
          </Group>
        )}
      </Canvas>

      <View
        style={StyleSheet.absoluteFill}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderStart={onStart}
        onResponderMove={onMove}
        onResponderRelease={onEnd}
        onResponderTerminate={onEnd}
      />

      <View style={styles.hud} pointerEvents="box-none">
        <Text style={styles.hudText}>
          {mission.name} · shells {player?.shellsOut ?? 0}/5 · mines{' '}
          {player?.minesOut ?? 0}/2 · enemies{' '}
          {alive.filter((t) => t.kind !== TankKind.Player).length}
        </Text>
        <Text
          style={styles.modeToggle}
          onPress={() => setFireMode((m) => (m === 'button' ? 'release' : 'button'))}
        >
          fire: {fireMode}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: PALETTE.background },
  hud: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  hudText: { color: '#e6edf3', fontSize: 12, opacity: 0.85 },
  modeToggle: {
    color: '#ffd966',
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
});
