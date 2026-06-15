import React, { useRef, useCallback, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, Modal, ScrollView,
} from 'react-native';
import type { CSBotSDKConfig, IssueCategory } from '@bitazza/csbot-core';
import { useConversation } from '@bitazza/csbot-core';
import type { StorageAdapter } from '@bitazza/csbot-core';
import type { IssueCategoryDef } from '@bitazza/csbot-core';
import { buildTheme, buildStyles } from '../theme';
import { MessageBubble } from './MessageBubble';
import { CategoryPicker } from './CategoryPicker';
import { TypingIndicator } from './TypingIndicator';
import { GuestIdentityForm } from './GuestIdentityForm';
import { PrevConversations } from './PrevConversations';

interface Props {
  cfg: CSBotSDKConfig;
  storage: StorageAdapter;
  categories: IssueCategoryDef[];
  onClose: () => void;
}

export function ChatWindow({ cfg, storage, categories, onClose }: Props) {
  const theme = buildTheme(cfg.primaryColor);
  const styles = buildStyles(theme);
  const listRef = useRef<FlatList>(null);

  const state = useConversation(cfg, storage);
  const [inputText, setInputText] = useState('');

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  const handleSend = useCallback(() => {
    if (!inputText.trim() && state.pendingAttachments.length === 0) return;
    state.send(inputText);
    setInputText('');
  }, [inputText, state]);

  // Scroll on new messages
  const flatListData = state.messages;

  return (
    <KeyboardAvoidingView
      style={styles.chatWindow}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarInitial}>{state.botName?.[0]?.toUpperCase() ?? 'B'}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>{state.botName ?? 'Bitazza Support'}</Text>
            <Text style={styles.headerSubtitle}>
              {state.wsState === 'open' ? (state.lang === 'th' ? 'ออนไลน์' : 'Online') :
               state.wsState === 'reconnecting' ? (state.lang === 'th' ? 'กำลังเชื่อมต่อใหม่...' : 'Reconnecting...') :
               (state.lang === 'th' ? 'ฝ่ายสนับสนุน' : 'Support')}
            </Text>
          </View>
        </View>
        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
          <Text style={styles.closeButtonText}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Agent connected banner */}
      {state.agentConnectedBanner && (
        <View style={{ backgroundColor: '#dcfce7', padding: 8, alignItems: 'center' }}>
          <Text style={{ color: '#15803d', fontWeight: '600', fontSize: 13 }}>
            {state.lang === 'th' ? `${state.agentConnectedBanner} เข้าร่วมการสนทนาแล้ว` : `${state.agentConnectedBanner} joined the conversation`}
          </Text>
        </View>
      )}

      {/* Open ticket resume banner */}
      {state.showOpenTicketBanner && state.openTicket && (
        <View style={{ backgroundColor: '#eff6ff', padding: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
          <Text style={{ color: '#1d4ed8', fontSize: 13, flex: 1 }}>
            {state.lang === 'th' ? 'คุณมีการสนทนาที่ค้างอยู่' : 'You have an open conversation'}
          </Text>
          <TouchableOpacity onPress={() => state.resumeTicket(state.openTicket!.id)}>
            <Text style={{ color: '#1d4ed8', fontWeight: '700', fontSize: 13 }}>
              {state.lang === 'th' ? 'ดูเลย' : 'Resume'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Previous conversations */}
      {state.showPrevTickets && state.prevTickets.length > 0 && (
        <PrevConversations
          tickets={state.prevTickets}
          lang={state.lang}
          theme={theme}
          cfg={cfg}
          onResume={state.resumeTicket}
        />
      )}

      {/* Message list */}
      <FlatList
        ref={listRef}
        data={flatListData}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            theme={theme}
            styles={styles}
            lang={state.lang}
            apiUrl={cfg.apiUrl}
            onDeclineResolution={state.declineResolution}
            onAcceptResolution={() => state.submitCsat(5)}
            onQuickReply={(text) => state.send(text)}
          />
        )}
        onContentSizeChange={scrollToBottom}
        style={styles.messageList}
        contentContainerStyle={{ paddingBottom: 8 }}
      />

      {/* Language picker */}
      {!state.langSelected && (
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, padding: 12, borderTopWidth: 1, borderColor: theme.border }}>
          {['en', 'th'].map((l) => (
            <TouchableOpacity
              key={l}
              onPress={() => state.selectLanguage(l)}
              style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: state.lang === l ? theme.primary : theme.border }}
            >
              <Text style={{ color: state.lang === l ? '#ffffff' : theme.textPrimary, fontWeight: '600' }}>
                {l === 'en' ? '🇬🇧 English' : '🇹🇭 ภาษาไทย'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Guest identity form */}
      {state.langSelected && state.isGuest && state.showGuestForm && (
        <GuestIdentityForm
          lang={state.lang}
          theme={theme}
          onSubmit={state.startGuestSession}
          onSkip={() => state.startGuestSession('', '')}
        />
      )}

      {/* Category picker */}
      {state.langSelected && !state.showGuestForm && !state.selectedCategory && (
        <CategoryPicker
          categories={categories}
          lang={state.lang}
          theme={theme}
          onSelect={state.selectCategory}
          disabled={state.loading}
        />
      )}

      {/* Typing indicator */}
      {state.loading && state.selectedCategory && <TypingIndicator theme={theme} />}

      {/* CSAT */}
      {state.csatPending && !state.csatSubmitted && state.convId && (
        <View style={{ padding: 12, alignItems: 'center', borderTopWidth: 1, borderColor: theme.border }}>
          <Text style={{ color: theme.textPrimary, fontWeight: '600', marginBottom: 8 }}>
            {state.lang === 'th' ? 'คุณพอใจกับการบริการแค่ไหน?' : 'How satisfied are you?'}
          </Text>
          <View style={styles.csatRow}>
            {[1, 2, 3, 4, 5].map((star) => (
              <TouchableOpacity key={star} onPress={() => state.submitCsat(star as 1 | 2 | 3 | 4 | 5)}>
                <Text style={styles.csatStar}>⭐</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Pending attachments preview */}
      {state.pendingAttachments.length > 0 && (
        <ScrollView horizontal style={{ paddingHorizontal: 12, paddingVertical: 6, maxHeight: 70 }}>
          {state.pendingAttachments.map((a) => (
            <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: theme.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, borderWidth: 1, borderColor: theme.border }}>
              <Text style={{ fontSize: 12, color: theme.textPrimary, maxWidth: 100 }} numberOfLines={1}>{a.name}</Text>
              <TouchableOpacity onPress={() => state.removePendingAttachment(a.id)} style={{ marginLeft: 6 }}>
                <Text style={{ color: '#ef4444', fontSize: 14 }}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Error bar */}
      {state.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{state.error}</Text>
        </View>
      )}

      {/* Input bar — only show when category is selected */}
      {state.langSelected && state.selectedCategory && (
        <View style={styles.inputBar}>
          <TextInput
            style={styles.textInput}
            placeholder={state.lang === 'th' ? 'พิมพ์ข้อความ...' : 'Type a message...'}
            placeholderTextColor={theme.textSecondary}
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={2000}
            returnKeyType="send"
            onSubmitEditing={handleSend}
          />
          <TouchableOpacity style={styles.sendButton} onPress={handleSend}>
            <Text style={styles.sendButtonText}>➤</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
