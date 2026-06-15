import type { IssueCategoryDef } from '@bitazza/csbot-core';

// GL supported languages — confirm exact list with product before shipping.
// 'vi' and 'id' labels below are placeholders; get translations from localization team.
export const SUPPORTED_LANGUAGES_GL = ['en', 'zh', 'ms', 'vi', 'id'] as const;
export type GLLanguage = typeof SUPPORTED_LANGUAGES_GL[number];

export const ISSUE_CATEGORIES_GL: IssueCategoryDef[] = [
  {
    key: 'kyc_verification',
    icon: '🪪',
    label: {
      en: 'KYC / Verification',
      zh: 'KYC / 身份验证',
      ms: 'KYC / Pengesahan',
      vi: 'KYC / Xác minh',       // TODO: confirm with localization
      id: 'KYC / Verifikasi',     // TODO: confirm with localization
    },
    openingMessage: {
      en: 'I need help with my KYC verification.',
      zh: '我需要帮助完成KYC验证。',
      ms: 'Saya memerlukan bantuan dengan pengesahan KYC saya.',
      vi: 'Tôi cần trợ giúp về xác minh KYC của mình.',
      id: 'Saya membutuhkan bantuan dengan verifikasi KYC saya.',
    },
  },
  {
    key: 'account_restriction',
    icon: '🔒',
    label: {
      en: 'Account restriction',
      zh: '账户限制',
      ms: 'Sekatan akaun',
      vi: 'Hạn chế tài khoản',
      id: 'Pembatasan akun',
    },
    openingMessage: {
      en: 'I need help with my account access.',
      zh: '我需要帮助访问我的账户。',
      ms: 'Saya memerlukan bantuan dengan akses akaun saya.',
      vi: 'Tôi cần trợ giúp về quyền truy cập tài khoản của mình.',
      id: 'Saya membutuhkan bantuan dengan akses akun saya.',
    },
  },
  {
    key: 'password_2fa_reset',
    icon: '🔑',
    label: {
      en: 'Password / 2FA reset',
      zh: '密码 / 双重验证重置',
      ms: 'Tetapan semula kata laluan / 2FA',
      vi: 'Đặt lại mật khẩu / 2FA',
      id: 'Reset kata sandi / 2FA',
    },
    openingMessage: {
      en: 'I need to reset my password or 2FA.',
      zh: '我需要重置密码或双重验证。',
      ms: 'Saya perlu menetapkan semula kata laluan atau 2FA saya.',
      vi: 'Tôi cần đặt lại mật khẩu hoặc 2FA của mình.',
      id: 'Saya perlu mereset kata sandi atau 2FA saya.',
    },
  },
  {
    key: 'fraud_security',
    icon: '🛡️',
    label: {
      en: 'Fraud / Security',
      zh: '欺诈 / 安全',
      ms: 'Penipuan / Keselamatan',
      vi: 'Gian lận / Bảo mật',
      id: 'Penipuan / Keamanan',
    },
    openingMessage: {
      en: 'I have a fraud or security concern.',
      zh: '我有欺诈或安全方面的问题。',
      ms: 'Saya mempunyai kebimbangan penipuan atau keselamatan.',
      vi: 'Tôi có mối lo ngại về gian lận hoặc bảo mật.',
      id: 'Saya memiliki masalah penipuan atau keamanan.',
    },
  },
  {
    key: 'withdrawal_issue',
    icon: '💸',
    label: {
      en: 'Withdrawal issue',
      zh: '提款问题',
      ms: 'Masalah pengeluaran',
      vi: 'Vấn đề rút tiền',
      id: 'Masalah penarikan',
    },
    openingMessage: {
      en: 'I have a problem with a withdrawal.',
      zh: '我的提款出现问题。',
      ms: 'Saya mempunyai masalah dengan pengeluaran.',
      vi: 'Tôi gặp vấn đề với việc rút tiền.',
      id: 'Saya mengalami masalah dengan penarikan.',
    },
  },
  {
    key: 'other',
    icon: '💬',
    label: {
      en: 'Other',
      zh: '其他',
      ms: 'Lain-lain',
      vi: 'Khác',
      id: 'Lainnya',
    },
    openingMessage: {
      en: 'I need help with something else.',
      zh: '我需要其他方面的帮助。',
      ms: 'Saya memerlukan bantuan dengan perkara lain.',
      vi: 'Tôi cần trợ giúp về vấn đề khác.',
      id: 'Saya membutuhkan bantuan dengan hal lain.',
    },
  },
];
