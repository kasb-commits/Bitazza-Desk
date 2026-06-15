import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import type { PastTicket, CSBotSDKConfig } from '@bitazza/csbot-core';
import { fetchPaginatedHistory } from '@bitazza/csbot-core';
import type { Theme } from '../theme';

interface Props {
  tickets: PastTicket[];
  lang: string;
  theme: Theme;
  cfg: CSBotSDKConfig;
  onResume: (ticketId: string) => void;
}

const STATUS_LABEL: Record<string, { en: string; th: string }> = {
  Open_Live: { en: 'Open', th: 'เปิด' },
  In_Progress: { en: 'In Progress', th: 'กำลังดำเนินการ' },
  Pending_Customer: { en: 'Pending', th: 'รอการตอบกลับ' },
  Escalated: { en: 'Escalated', th: 'ส่งต่อเจ้าหน้าที่' },
  Closed_Resolved: { en: 'Resolved', th: 'แก้ไขแล้ว' },
  Closed_Unresponsive: { en: 'Closed', th: 'ปิด' },
};

export function PrevConversations({ tickets, lang, theme, cfg, onResume }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [historyMap, setHistoryMap] = useState<Record<string, { content: string }[]>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const expand = useCallback(async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (historyMap[id]) return;
    setLoadingId(id);
    try {
      const { messages } = await fetchPaginatedHistory(cfg, id, 1, 5);
      setHistoryMap((prev) => ({ ...prev, [id]: messages.map((m) => ({ content: m.content })) }));
    } catch { /* ignore */ }
    finally { setLoadingId(null); }
  }, [expanded, historyMap, cfg]);

  const renderItem = ({ item }: { item: PastTicket }) => {
    const statusLabel = STATUS_LABEL[item.status]?.[lang as 'en' | 'th'] ?? item.status;
    const isOpen = !['Closed_Resolved', 'Closed_Unresponsive'].includes(item.status);
    const isExpanded = expanded === item.id;

    return (
      <TouchableOpacity
        onPress={() => expand(item.id)}
        style={{ backgroundColor: theme.surface, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: theme.border }}
        activeOpacity={0.8}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontWeight: '600', color: theme.textPrimary, fontSize: 14, flex: 1, marginRight: 8 }}>{item.category.replace(/_/g, ' ')}</Text>
          <View style={{ backgroundColor: isOpen ? '#dcfce7' : '#f3f4f6', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 }}>
            <Text style={{ fontSize: 11, color: isOpen ? '#15803d' : theme.textSecondary }}>{statusLabel}</Text>
          </View>
        </View>
        {item.lastMessage ? (
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }} numberOfLines={1}>{item.lastMessage}</Text>
        ) : null}
        {loadingId === item.id && <ActivityIndicator size="small" color={theme.primary} style={{ marginTop: 8 }} />}
        {isExpanded && historyMap[item.id] && (
          <View style={{ marginTop: 8, gap: 4 }}>
            {historyMap[item.id].map((m, i) => (
              <Text key={i} style={{ color: theme.textSecondary, fontSize: 12 }} numberOfLines={2}>{m.content}</Text>
            ))}
            {isOpen && (
              <TouchableOpacity
                onPress={() => onResume(item.id)}
                style={{ marginTop: 6, backgroundColor: theme.primary, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6, alignSelf: 'flex-start' }}
              >
                <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 13 }}>{lang === 'th' ? 'ต่อการสนทนา' : 'Resume'}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <FlatList
      data={tickets}
      keyExtractor={(t) => t.id}
      renderItem={renderItem}
      contentContainerStyle={{ padding: 12 }}
      scrollEnabled={false}
    />
  );
}
