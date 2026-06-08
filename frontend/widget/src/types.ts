export type MessageRole = 'user' | 'assistant' | 'agent' | 'system';

export type IssueCategory =
  | 'kyc_verification'
  | 'account_restriction'
  | 'password_2fa_reset'
  | 'fraud_security'
  | 'withdrawal_issue'
  | 'other';

export interface IssueCategoryDef {
  key: IssueCategory;
  icon: string;
  label: { en: string; th: string };
  /** Short text sent as the opening user message when selected */
  openingMessage: { en: string; th: string };
}

export const ISSUE_CATEGORIES: IssueCategoryDef[] = [
  {
    key: 'kyc_verification',
    icon: '🪪',
    label: { en: 'KYC verification', th: 'ยืนยันตัวตน (KYC)' },
    openingMessage: { en: 'I need help with my KYC verification.', th: 'ฉันต้องการความช่วยเหลือเกี่ยวกับการยืนยันตัวตน KYC' },
  },
  {
    key: 'account_restriction',
    icon: '🔒',
    label: { en: 'Account restriction', th: 'บัญชีถูกระงับ' },
    openingMessage: { en: 'I need help with my account access.', th: 'ฉันต้องการความช่วยเหลือเกี่ยวกับการเข้าถึงบัญชี' },
  },
  {
    key: 'password_2fa_reset',
    icon: '🔑',
    label: { en: 'Password / 2FA reset', th: 'รีเซ็ตรหัสผ่าน / 2FA' },
    openingMessage: { en: 'I need to reset my password or 2FA.', th: 'ฉันต้องการรีเซ็ตรหัสผ่านหรือ 2FA' },
  },
  {
    key: 'fraud_security',
    icon: '🛡️',
    label: { en: 'Fraud / Security', th: 'การฉ้อโกง / ความปลอดภัย' },
    openingMessage: { en: 'I have a fraud or security concern.', th: 'ฉันมีปัญหาเกี่ยวกับการฉ้อโกงหรือความปลอดภัย' },
  },
  {
    key: 'withdrawal_issue',
    icon: '💸',
    label: { en: 'Withdrawal issue', th: 'ปัญหาการถอนเงิน' },
    openingMessage: { en: 'I have a problem with a withdrawal.', th: 'ฉันมีปัญหาเกี่ยวกับการถอนเงิน' },
  },
  {
    key: 'other',
    icon: '💬',
    label: { en: 'Other', th: 'อื่นๆ' },
    openingMessage: { en: 'I need help with something else.', th: 'ฉันต้องการความช่วยเหลือเรื่องอื่น' },
  },
];

export interface MessageAttachment {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  escalated?: boolean;
  agentName?: string;
  agentAvatar?: string;
  agentAvatarUrl?: string;
  offerResolution?: boolean;
  /** Explicit sender name to display — overrides the dynamic botName. Used to pin static messages to "Bitazza Support". */
  senderName?: string;
  attachments?: MessageAttachment[];
  quickReplies?: string[];
}

export interface CSBotConfig {
  platform: 'freedom' | 'bitazza' | 'web';
  apiUrl: string;
  token?: string;        // JWT from host app, optional
  primaryColor?: string; // hex, default #00CE80 (Primary/GL/700)
  lang?: 'en' | 'th';   // override auto-detect
  guestMode?: boolean;   // true = skip token fetch, show GuestIdentityForm
}

declare global {
  interface Window {
    CSBotConfig: CSBotConfig;
  }
}
