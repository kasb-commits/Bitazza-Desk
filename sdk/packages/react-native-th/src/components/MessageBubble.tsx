import React from 'react';
import { View, Text, Image, TouchableOpacity } from 'react-native';
import type { Message } from '@bitazza/csbot-core';
import type { Theme } from '../theme';
import type { ReturnType as StylesType } from '../theme';

interface Props {
  message: Message;
  theme: Theme;
  styles: ReturnType<typeof import('../theme').buildStyles>;
  lang: string;
  onDeclineResolution?: () => void;
  onAcceptResolution?: () => void;
  onQuickReply?: (text: string) => void;
  apiUrl: string;
}

function resolveUrl(url: string | null | undefined, apiUrl: string): string | null {
  if (!url) return null;
  return url.startsWith('/') ? `${apiUrl}${url}` : url;
}

export function MessageBubble({ message, theme, styles, lang, onDeclineResolution, onAcceptResolution, onQuickReply, apiUrl }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const timeStr = new Date(message.timestamp).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const avatarUrl = resolveUrl(message.agentAvatarUrl, apiUrl);
  const displayName = message.senderName ?? message.agentName;

  if (isSystem) {
    return (
      <View style={{ alignItems: 'center', marginVertical: 6 }}>
        <Text style={{ color: theme.textSecondary, fontSize: 12, backgroundColor: theme.border, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 }}>{message.content}</Text>
      </View>
    );
  }

  if (isUser) {
    return (
      <View style={styles.userRow}>
        <View>
          <View style={styles.userBubble}>
            <Text style={styles.userBubbleText}>{message.content}</Text>
            {message.attachments?.map((a) => (
              <Text key={a.id} style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 4 }}>📎 {a.name}</Text>
            ))}
          </View>
          <Text style={[styles.timestamp, { textAlign: 'right' }]}>{timeStr}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.botRow}>
      {/* Avatar */}
      <View>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
        ) : (
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarInitial}>{displayName?.[0]?.toUpperCase() ?? 'B'}</Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1, maxWidth: '75%' }}>
        {displayName ? <Text style={styles.senderName}>{displayName}</Text> : null}
        <View style={styles.botBubble}>
          <Text style={styles.botBubbleText}>{message.content}</Text>
          {message.attachments?.map((a) => (
            <Text key={a.id} style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>📎 {a.name}</Text>
          ))}
        </View>
        {message.offerResolution && (
          <View style={styles.resolutionBanner}>
            <TouchableOpacity style={styles.resolutionYes} onPress={onAcceptResolution}>
              <Text style={styles.resolutionYesText}>{lang === 'th' ? '✅ แก้ไขแล้ว' : '✅ Yes, resolved'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.resolutionNo} onPress={onDeclineResolution}>
              <Text style={styles.resolutionNoText}>{lang === 'th' ? '❌ ยังไม่แก้ไข' : '❌ Not yet'}</Text>
            </TouchableOpacity>
          </View>
        )}
        {message.quickReplies && message.quickReplies.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {message.quickReplies.map((qr) => (
              <TouchableOpacity
                key={qr}
                onPress={() => onQuickReply?.(qr)}
                style={{ borderWidth: 1, borderColor: theme.primary, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 }}
              >
                <Text style={{ color: theme.primary, fontSize: 13 }}>{qr}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <Text style={styles.timestamp}>{timeStr}</Text>
      </View>
    </View>
  );
}
