import type { SupportedLanguage } from '@bitazza/csbot-core';
import { SUPPORTED_LANGUAGES_GL } from './categories';

// Unicode script ranges for detection
const THAI_RANGE = /[\u0E00-\u0E7F]/;
const CHINESE_RANGE = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
const ARABIC_RANGE = /[\u0600-\u06FF]/; // Malay can be written in Jawi (Arabic script)

/**
 * Detect language from message text.
 * Falls back to deviceLocale, then to 'en'.
 * Always clamps to the supported languages list.
 */
export function detectLanguage(
  text: string,
  deviceLocale: string,
  supported: SupportedLanguage[] = [...SUPPORTED_LANGUAGES_GL],
): SupportedLanguage {
  const clamp = (lang: string): SupportedLanguage =>
    supported.includes(lang) ? lang : 'en';

  // 1. Unicode script detection from text
  if (THAI_RANGE.test(text)) return clamp('th');
  if (CHINESE_RANGE.test(text)) return clamp('zh');
  // Vietnamese uses Latin + diacritics — hard to distinguish from English by script alone.
  // Rely on device locale for vi/id/ms.

  // 2. Device locale (BCP 47: "zh-CN", "ms-MY", "vi-VN", etc.)
  if (deviceLocale) {
    const base = deviceLocale.split('-')[0].toLowerCase();
    if (supported.includes(base)) return base;
  }

  return 'en';
}

/**
 * Get device locale using expo-localization if available,
 * falling back to react-native-localize, then to navigator.language on web.
 */
export function getDeviceLocale(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getLocales } = require('expo-localization');
    return getLocales()[0]?.languageTag ?? 'en';
  } catch { /* expo-localization not installed */ }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RNLocalize = require('react-native-localize');
    return RNLocalize.getLocales()[0]?.languageTag ?? 'en';
  } catch { /* react-native-localize not installed */ }

  // Web fallback
  if (typeof navigator !== 'undefined') return navigator.language ?? 'en';

  return 'en';
}
