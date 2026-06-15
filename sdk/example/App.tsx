/**
 * CSBot SDK Example App
 *
 * Run against the mock server:
 *   cd sdk/mock-server && npm install && node server.js
 *
 * Then start this app:
 *   cd sdk/example && npx expo start --ios   (or --android)
 *
 * Toggle REGION to switch between TH and GL widgets.
 */
import React, { useState } from 'react';
import { SafeAreaView, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CSBotWidget } from '@bitazza/csbot-react-native-th';
import { CSBotWidget as CSBotWidgetGL } from '@bitazza/csbot-react-native-gl';

// Point to mock server. On iOS Simulator use localhost; on Android Emulator use 10.0.2.2
const API_URL = 'http://localhost:8001';

type Region = 'TH' | 'GL';

export default function App() {
  const [region, setRegion] = useState<Region>('TH');

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />

      {/* Region switcher */}
      <View style={styles.switcher}>
        <Text style={styles.title}>CSBot SDK Example</Text>
        <View style={styles.tabs}>
          {(['TH', 'GL'] as Region[]).map((r) => (
            <TouchableOpacity
              key={r}
              style={[styles.tab, region === r && styles.tabActive]}
              onPress={() => setRegion(r)}
            >
              <Text style={[styles.tabText, region === r && styles.tabTextActive]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.hint}>
          {region === 'TH'
            ? 'Freedom Thailand — EN + TH support'
            : 'Bitazza Global — EN, ZH, MS, VI, ID support'}
        </Text>
      </View>

      {/* Widget renders as FAB + Modal — appears as floating button */}
      {region === 'TH' ? (
        <CSBotWidget
          apiUrl={API_URL}
          platform="freedom"
          primaryColor="#1a56db"
        />
      ) : (
        <CSBotWidgetGL
          apiUrl={API_URL}
          platform="bitazza"
          primaryColor="#0f766e"
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  switcher: { padding: 20, alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '700', color: '#1e293b', marginBottom: 16 },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  tab: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20, backgroundColor: '#e2e8f0' },
  tabActive: { backgroundColor: '#1a56db' },
  tabText: { fontWeight: '600', color: '#64748b' },
  tabTextActive: { color: '#fff' },
  hint: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
