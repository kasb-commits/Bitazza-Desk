import { AppState } from 'react-native';

/**
 * Default notification sound using expo-av.
 * Pass this to CSBotSDKConfig.onNotificationSound, or provide your own.
 * If expo-av is not installed the function exits silently — no crash.
 */
export async function defaultNotificationSound(): Promise<void> {
  if (AppState.currentState !== 'active') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Audio } = require('expo-av');
    const { sound } = await Audio.Sound.createAsync(
      // Host app must copy notify.mp3 to their assets and update the path,
      // or replace this entire function with their own audio implementation.
      require('./assets/notify.mp3'),
    );
    await sound.playAsync();
    sound.setOnPlaybackStatusUpdate((status: { didJustFinish?: boolean }) => {
      if (status.didJustFinish) sound.unloadAsync().catch(() => {});
    });
  } catch {
    // expo-av not installed or asset missing — fail silently
  }
}
