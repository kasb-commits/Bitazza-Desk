import type { IssueCategoryDef } from '@bitazza/csbot-core';

export const SUPPORTED_LANGUAGES_TH = ['en', 'th'] as const;
export type THLanguage = typeof SUPPORTED_LANGUAGES_TH[number];

export const ISSUE_CATEGORIES_TH: IssueCategoryDef[] = [
  {
    key: 'kyc_verification',
    icon: '🪪',
    label: { en: 'KYC / Verification', th: 'ยืนยันตัวตน (KYC)' },
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
