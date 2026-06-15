import { StyleSheet } from 'react-native';

export interface Theme {
  primary: string;
  primaryDark: string;
  background: string;
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  userBubble: string;
  userBubbleText: string;
  botBubble: string;
  botBubbleText: string;
}

export function buildTheme(primaryColor = '#1a56db'): Theme {
  return {
    primary: primaryColor,
    primaryDark: darken(primaryColor),
    background: '#f9fafb',
    surface: '#ffffff',
    border: '#e5e7eb',
    textPrimary: '#111827',
    textSecondary: '#6b7280',
    userBubble: primaryColor,
    userBubbleText: '#ffffff',
    botBubble: '#f3f4f6',
    botBubbleText: '#111827',
  };
}

function darken(hex: string): string {
  // Simple darken: reduce RGB by ~15%
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const factor = 0.85;
  return `#${Math.round(r * factor).toString(16).padStart(2, '0')}${Math.round(g * factor).toString(16).padStart(2, '0')}${Math.round(b * factor).toString(16).padStart(2, '0')}`;
}

export function buildStyles(theme: Theme) {
  return StyleSheet.create({
    // FAB
    fab: {
      position: 'absolute',
      bottom: 24,
      right: 24,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: theme.primary,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 6,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.25,
      shadowRadius: 6,
    },
    fabText: { fontSize: 24 },
    // Modal / window
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    chatWindow: { backgroundColor: theme.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, height: '90%' },
    // Header
    header: { backgroundColor: '#090916', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
    headerTitle: { color: '#ffffff', fontWeight: '600', fontSize: 15 },
    headerSubtitle: { color: '#9ca3af', fontSize: 12 },
    closeButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#2C2C53', alignItems: 'center', justifyContent: 'center' },
    closeButtonText: { color: '#ffffff', fontSize: 18, lineHeight: 20 },
    // Avatar
    avatarCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.primary },
    avatarInitial: { color: '#ffffff', fontWeight: '700', fontSize: 14 },
    avatarImage: { width: 36, height: 36, borderRadius: 18 },
    // Messages
    messageList: { flex: 1, paddingHorizontal: 12, paddingVertical: 8 },
    userRow: { flexDirection: 'row', justifyContent: 'flex-end', marginVertical: 4 },
    botRow: { flexDirection: 'row', justifyContent: 'flex-start', marginVertical: 4, gap: 8 },
    userBubble: { backgroundColor: theme.userBubble, borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '75%' },
    botBubble: { backgroundColor: theme.botBubble, borderRadius: 16, borderBottomLeftRadius: 4, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '75%' },
    userBubbleText: { color: theme.userBubbleText, fontSize: 15, lineHeight: 21 },
    botBubbleText: { color: theme.botBubbleText, fontSize: 15, lineHeight: 21 },
    timestamp: { color: theme.textSecondary, fontSize: 11, marginTop: 3 },
    senderName: { color: theme.textSecondary, fontSize: 11, marginBottom: 2 },
    // Input bar
    inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, backgroundColor: theme.surface, borderTopWidth: 1, borderTopColor: theme.border, gap: 8 },
    textInput: { flex: 1, borderWidth: 1, borderColor: theme.border, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, maxHeight: 80, backgroundColor: theme.background, color: theme.textPrimary },
    sendButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center' },
    sendButtonText: { color: '#ffffff', fontSize: 18 },
    attachButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    attachButtonText: { fontSize: 20 },
    // Category picker
    categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', padding: 12, gap: 8 },
    categoryCard: { width: '47%', backgroundColor: theme.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: theme.border, alignItems: 'center', gap: 6 },
    categoryIcon: { fontSize: 28 },
    categoryLabel: { fontSize: 13, fontWeight: '600', color: theme.textPrimary, textAlign: 'center' },
    // CSAT
    csatRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, padding: 12 },
    csatStar: { fontSize: 28 },
    // Typing indicator
    typingRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
    typingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.textSecondary },
    // Resolution banner
    resolutionBanner: { flexDirection: 'row', justifyContent: 'center', gap: 12, padding: 8 },
    resolutionYes: { backgroundColor: theme.primary, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 8 },
    resolutionNo: { backgroundColor: theme.border, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 8 },
    resolutionYesText: { color: '#ffffff', fontWeight: '600' },
    resolutionNoText: { color: theme.textPrimary, fontWeight: '600' },
    // Error
    errorBar: { backgroundColor: '#fef2f2', borderTopWidth: 1, borderColor: '#fecaca', padding: 10, alignItems: 'center' },
    errorText: { color: '#dc2626', fontSize: 13 },
  });
}
