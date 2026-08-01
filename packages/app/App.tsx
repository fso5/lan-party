import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { GameScreen } from './src/game/GameScreen';

export default function App() {
  return (
    <View style={styles.container}>
      <GameScreen missionIndex={0} />
      <StatusBar hidden />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
});
