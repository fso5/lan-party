import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { GameScreen } from './src/game/GameScreen';
import { HostScreen } from './src/game/HostScreen';

type Screen = 'menu' | 'solo' | 'host';

export default function App() {
  const [screen, setScreen] = useState<Screen>('menu');

  return (
    <View style={styles.container}>
      {screen === 'menu' && <Menu onPick={setScreen} />}
      {screen === 'solo' && <GameScreen missionIndex={0} />}
      {screen === 'host' && <HostScreen onBack={() => setScreen('menu')} />}
      <StatusBar hidden />
    </View>
  );
}

function Menu({ onPick }: { onPick: (s: Screen) => void }) {
  return (
    <View style={styles.menu}>
      <Text style={styles.title}>Tanks!</Text>

      <TouchableOpacity style={styles.button} onPress={() => onPick('solo')}>
        <Text style={styles.buttonText}>Play solo</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.button} onPress={() => onPick('host')}>
        <Text style={styles.buttonText}>Host over WiFi</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        Hosting needs no internet — a hotspot is enough. Everyone else joins by opening a URL in
        their browser, so iPhones need nothing installed.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  menu: { flex: 1, justifyContent: 'center', padding: 32, gap: 16 },
  title: { fontSize: 44, fontWeight: '800', color: '#EDE5D3', marginBottom: 12 },
  button: { backgroundColor: '#2f6fd0', padding: 18, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: 'white', fontSize: 19, fontWeight: '600' },
  hint: { color: '#9A9080', fontSize: 14, lineHeight: 20, marginTop: 12 },
});
