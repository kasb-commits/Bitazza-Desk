// Re-export everything from core and TH (shared components, hooks, utils)
export * from '@bitazza/csbot-core';
export * from '@bitazza/csbot-react-native-th';

// GL-specific overrides (these shadow the TH exports of the same name)
export { ISSUE_CATEGORIES_GL, SUPPORTED_LANGUAGES_GL } from './categories';
export type { GLLanguage } from './categories';
export { detectLanguage, getDeviceLocale } from './languageDetection';
export { LanguagePicker } from './components/LanguagePicker';
export { CSBotWidgetGL as CSBotWidget } from './components/CSBotWidgetGL';
