import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../theme';

interface Props {
  lang: string;
  theme: Theme;
  onSubmit: (name: string, email: string) => void;
  onSkip: () => void;
}

const COPY = {
  en: {
    heading: 'Before we start',
    namePlaceholder: 'Your name (optional)',
    emailPlaceholder: 'Your email (optional)',
    submit: 'Start chat',
    skip: 'Skip',
  },
  th: {
    heading: 'ก่อนเริ่มการสนทนา',
    namePlaceholder: 'ชื่อของคุณ (ไม่บังคับ)',
    emailPlaceholder: 'อีเมลของคุณ (ไม่บังคับ)',
    submit: 'เริ่มสนทนา',
    skip: 'ข้าม',
  },
};

export function GuestIdentityForm({ lang, theme, onSubmit, onSkip }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const t = COPY[lang as keyof typeof COPY] ?? COPY.en;

  return (
    <View style={[styles.container, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.heading, { color: theme.textPrimary }]}>{t.heading}</Text>
      <TextInput
        style={[styles.input, { borderColor: theme.border, color: theme.textPrimary, backgroundColor: theme.background }]}
        placeholder={t.namePlaceholder}
        placeholderTextColor={theme.textSecondary}
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
      />
      <TextInput
        style={[styles.input, { borderColor: theme.border, color: theme.textPrimary, backgroundColor: theme.background }]}
        placeholder={t.emailPlaceholder}
        placeholderTextColor={theme.textSecondary}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <TouchableOpacity style={[styles.submit, { backgroundColor: theme.primary }]} onPress={() => onSubmit(name, email)}>
        <Text style={styles.submitText}>{t.submit}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.skip} onPress={onSkip}>
        <Text style={[styles.skipText, { color: theme.textSecondary }]}>{t.skip}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: 16, padding: 20, margin: 12, borderWidth: 1, gap: 10 },
  heading: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },
  submit: { borderRadius: 22, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  submitText: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
  skip: { alignItems: 'center', paddingVertical: 6 },
  skipText: { fontSize: 14 },
});
