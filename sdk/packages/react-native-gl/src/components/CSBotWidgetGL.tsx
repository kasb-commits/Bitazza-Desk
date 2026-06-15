import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, Modal, Animated, Easing } from 'react-native';
import type { CSBotSDKConfig } from '@bitazza/csbot-core';
import {
  buildTheme, buildStyles, getAsyncStorageAdapter, ChatWindow,
} from '@bitazza/csbot-react-native-th';
import { ISSUE_CATEGORIES_GL, SUPPORTED_LANGUAGES_GL } from '../categories';

interface Props extends Partial<CSBotSDKConfig> {
  apiUrl: string;
  platform?: 'bitazza' | 'freedom' | 'web';
  token?: string;
  primaryColor?: string;
}

export function CSBotWidgetGL({ apiUrl, platform = 'bitazza', token, primaryColor, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const ringAnim = useRef(new Animated.Value(1)).current;
  const storage = getAsyncStorageAdapter();
  const theme = buildTheme(primaryColor);
  const styles = buildStyles(theme);

  const cfg: CSBotSDKConfig = {
    apiUrl,
    platform,
    token,
    primaryColor,
    supportedLanguages: [...SUPPORTED_LANGUAGES_GL],
    ...rest,
  };

  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ringAnim, { toValue: 1.4, duration: 1000, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(ringAnim, { toValue: 1, duration: 1000, easing: Easing.in(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <>
      <View style={styles.fab}>
        <Animated.View
          style={{
            position: 'absolute',
            width: 56, height: 56, borderRadius: 28,
            backgroundColor: theme.primary,
            opacity: 0.3,
            transform: [{ scale: ringAnim }],
          }}
        />
        <TouchableOpacity onPress={() => setOpen(true)} style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 26 }}>💬</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.modalOverlay}>
          {/* ChatWindow from TH package — GL overrides categories */}
          <ChatWindow
            cfg={cfg}
            storage={storage}
            categories={ISSUE_CATEGORIES_GL}
            onClose={() => setOpen(false)}
          />
        </View>
      </Modal>
    </>
  );
}
