/**
 * The app shell.
 *
 * The game itself -- simulation, renderer, controls, netcode -- runs inside a
 * WebView, loaded from a string bundled into the binary. There is deliberately
 * no port of the renderer to native here, and the reason is worth stating
 * plainly: the web build is the only version of this game that has actually
 * been run and verified. Rewriting a working canvas renderer into Skia, sight
 * unseen, in order to ship a first APK, would replace a proven component with
 * an unproven one at exactly the moment we need to trust it.
 *
 * What native does own is the radio. `BleAdapter` in @tanks/core was designed
 * as the seam for precisely this: the WebView asks to send a frame, we post it
 * across the bridge, and the native Bluetooth stack puts it on the air. That
 * boundary is a few hundred bytes a second of small messages, so the bridge
 * cost is irrelevant next to the 45ms the radio itself takes.
 *
 * A native Skia renderer is the right eventual answer -- WebView costs some
 * frame budget and rules out real background behaviour. It is just not the
 * thing to do before the delivery pipeline and the radio both work.
 */

import { useCallback, useRef, useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { GAME_HTML } from './src/generated/gameHtml';

/**
 * Messages crossing the bridge.
 *
 * Binary frames are base64 encoded because postMessage carries strings. That
 * costs 33% overhead on a payload measured in hundreds of bytes per second,
 * which is not worth a more complicated scheme.
 */
type BridgeMessage =
  | { type: 'ready' }
  | { type: 'log'; text: string }
  | { type: 'ble.host'; matchName: string }
  | { type: 'ble.discover' }
  | { type: 'ble.connect'; peerId: string }
  | { type: 'ble.send'; to: string; frame: string; ack: boolean };

export default function App() {
  const webRef = useRef<WebView>(null);
  const [status, setStatus] = useState('starting');

  /** Push an event down into the page. */
  const toWeb = useCallback((event: unknown) => {
    const json = JSON.stringify(event);
    // Wrapped in a guard: the page may not have installed its handler yet
    // during startup, and an exception here silently kills the injection.
    webRef.current?.injectJavaScript(
      `window.__tanksNative && window.__tanksNative.receive(${JSON.stringify(json)}); true;`,
    );
  }, []);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'ready':
          setStatus('running');
          break;
        case 'log':
          console.log('[game]', msg.text);
          break;

        // Bluetooth is not wired up yet -- the native module that owns
        // advertising and the GATT server is the next piece of work. Answering
        // explicitly rather than ignoring these keeps the page out of a state
        // where it waits forever for a host that will never appear.
        case 'ble.host':
        case 'ble.discover':
        case 'ble.connect':
        case 'ble.send':
          toWeb({ type: 'ble.unavailable', reason: 'radio not implemented in this build' });
          break;
      }
    },
    [toWeb],
  );

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar hidden />
      <WebView
        ref={webRef}
        style={styles.web}
        source={{ html: GAME_HTML, baseUrl: 'https://tanks.local/' }}
        originWhitelist={['*']}
        onMessage={onMessage}
        // The game draws its own background; without this the WebView flashes
        // white on every load, which is jarring in a dark game.
        containerStyle={styles.web}
        // A canvas game must not bounce, zoom, or select text under the thumbs.
        bounces={false}
        scrollEnabled={false}
        overScrollMode="never"
        scalesPageToFit={false}
        setBuiltInZoomControls={false}
        allowsInlineMediaPlayback
        javaScriptEnabled
        domStorageEnabled
        onError={(e) => setStatus(`webview error: ${e.nativeEvent.description}`)}
        onRenderProcessGone={() => setStatus('renderer crashed — reopen the app')}
      />
      {status !== 'running' && (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.overlayText}>{status}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#16140F' },
  web: { flex: 1, backgroundColor: '#16140F' },
  overlay: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  overlayText: { color: '#9A9080', fontSize: 11 },
});
