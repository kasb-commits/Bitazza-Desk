import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import type { SupportedLanguage } from '@bitazza/csbot-core';
import type { Theme } from '@bitazza/csbot-react-native-th';

interface Props {
  supported: SupportedLanguage[];
  selected: SupportedLanguage;
  theme: Theme;
  onSelect: (lang: SupportedLanguage) => void;
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: '🇬🇧 English',
  zh: '🇨🇳 中文',
  ms: '🇲🇾 Bahasa Melayu',
  vi: '🇻🇳 Tiếng Việt',
  id: '🇮🇩 Bahasa Indonesia',
  th: '🇹🇭 ภาษาไทย',
};

export function LanguagePicker({ supported, selected, theme, onSelect }: Props) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ padding: 12, gap: 8 }}
    >
      {supported.map((lang) => (
        <TouchableOpacity
          key={lang}
          onPress={() => onSelect(lang)}
          style={{
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 20,
            backgroundColor: selected === lang ? theme.primary : theme.border,
          }}
        >
          <Text style={{
            color: selected === lang ? '#ffffff' : theme.textPrimary,
            fontWeight: '600',
            fontSize: 13,
          }}>
            {LANGUAGE_LABELS[lang] ?? lang.toUpperCase()}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}
