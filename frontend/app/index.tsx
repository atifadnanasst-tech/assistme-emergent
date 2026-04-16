import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function Index() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>AssistMe</Text>
        <Text style={styles.subtitle}>WhatsApp-style Business OS</Text>
        <Text style={styles.message}>Awaiting Flow 1: Auth Setup</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#075E54',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 48,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 18,
    color: '#E8F5E9',
    marginBottom: 32,
  },
  message: {
    fontSize: 14,
    color: '#B2DFDB',
    textAlign: 'center',
  },
});
