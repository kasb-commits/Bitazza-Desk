import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import type { IssueCategory } from '@bitazza/csbot-core';
import type { IssueCategoryDef } from '@bitazza/csbot-core';
import type { Theme } from '../theme';

interface Props {
  categories: IssueCategoryDef[];
  lang: string;
  theme: Theme;
  onSelect: (cat: IssueCategory) => void;
  disabled?: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  kyc_verification: '#3b82f6',
  account_restriction: '#ef4444',
  password_2fa_reset: '#f59e0b',
  fraud_security: '#8b5cf6',
  withdrawal_issue: '#10b981',
  other: '#6b7280',
};

export function CategoryPicker({ categories, lang, theme, onSelect, disabled }: Props) {
  return (
    <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', padding: 12, gap: 8 }}>
      {categories.map((cat) => {
        const color = CATEGORY_COLORS[cat.key] ?? theme.primary;
        return (
          <TouchableOpacity
            key={cat.key}
            disabled={disabled}
            onPress={() => onSelect(cat.key)}
            style={{
              width: '47%',
              backgroundColor: theme.surface,
              borderRadius: 12,
              padding: 14,
              borderWidth: 1,
              borderColor: theme.border,
              alignItems: 'center',
              gap: 6,
              opacity: disabled ? 0.5 : 1,
            }}
            activeOpacity={0.75}
          >
            <Text style={{ fontSize: 28 }}>{cat.icon}</Text>
            <View style={{ width: 32, height: 3, borderRadius: 2, backgroundColor: color }} />
            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.textPrimary, textAlign: 'center' }}>
              {cat.label[lang] ?? cat.label['en']}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}
