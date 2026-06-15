// Re-export everything from core so consumers only need one import
export * from '@bitazza/csbot-core';

// TH-specific exports
export { ISSUE_CATEGORIES_TH, SUPPORTED_LANGUAGES_TH } from './categories';
export type { THLanguage } from './categories';
export { buildTheme, buildStyles } from './theme';
export type { Theme } from './theme';
export { getAsyncStorageAdapter, makeAsyncStorageAdapter } from './storage';
export { defaultNotificationSound } from './sound';

// Components
export { CSBotWidget } from './components/CSBotWidget';
export { ChatWindow } from './components/ChatWindow';
export { MessageBubble } from './components/MessageBubble';
export { CategoryPicker } from './components/CategoryPicker';
export { TypingIndicator } from './components/TypingIndicator';
export { PrevConversations } from './components/PrevConversations';
export { GuestIdentityForm } from './components/GuestIdentityForm';
