/**
 * useConversation hook integration tests.
 *
 * Strategy:
 * - Mock all fetch calls and the WebSocket (no real network/WS)
 * - Use @testing-library/react renderHook to exercise the hook
 * - Focus on the state machine paths: init, selectLanguage, selectCategory, send, reset
 */
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConversation } from '../src/useConversation';
import { localStorageAdapter } from '../src/storage';
import type { CSBotSDKConfig } from '../src/types';

// ── WebSocket mock ────────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) { setTimeout(() => this.onopen?.(), 0); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
}

(global as any).WebSocket = MockWebSocket;

// ── fetch mock helpers ────────────────────────────────────────────────────────

const cfg: CSBotSDKConfig = {
  platform: 'bitazza',
  apiUrl: 'http://localhost:8001',
  supportedLanguages: ['en', 'th'],
};

function mockFetch(responses: Record<string, unknown>) {
  global.fetch = jest.fn().mockImplementation((url: string) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = key ? responses[key] : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as jest.Mock;
}

const defaultMocks: Record<string, unknown> = {
  '/chat/start': { conversation_id: 'conv-test', is_guest: false },
  '/chat/greet': { greeting: 'Hi!', bot_name: 'Aria', agent_avatar_url: null },
  '/chat/set-category': { agent_name: 'Aria', agent_avatar: 'A', agent_avatar_url: null },
  '/chat/message': { reply: 'I can help!', language: 'en', escalated: false, ticket_id: 'tkt-1', offer_resolution: false, quick_replies: [] },
  '/chat/history': { history: [], human_handling: false, ticket_status: null },
  '/chat/customer-tickets': { tickets: [] },
  '/chat/open-ticket': { ticket: null },
  '/chat/announcement': { announcements: [] },
  '/chat/csat': {},
};

beforeEach(() => {
  localStorage.clear();
  mockFetch(defaultMocks);
});

afterEach(() => {
  jest.resetAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useConversation — initial state', () => {
  test('starts with empty messages and correct defaults', () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    expect(result.current.messages).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.lang).toBe('en');
    expect(result.current.langSelected).toBe(false);
    expect(result.current.selectedCategory).toBeNull();
    expect(result.current.escalated).toBe(false);
    expect(result.current.isGuest).toBe(false);
    expect(result.current.wsState).toBe('closed');
    expect(result.current.error).toBeNull();
  });

  test('shows greeting message on mount', async () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0));
    expect(result.current.messages[0].role).toBe('assistant');
    expect(result.current.messages[0].content).toContain('Hi');
  });

  test('sets convId after startConversation resolves', async () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.convId).toBe('conv-test'));
  });
});

describe('useConversation — selectLanguage', () => {
  test('updates lang and sets langSelected=true', async () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.convId).toBe('conv-test'));

    await act(async () => { result.current.selectLanguage('th'); });
    expect(result.current.lang).toBe('th');
    expect(result.current.langSelected).toBe(true);
  });

  test('adds category-prompt message after language selection', async () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.convId).toBe('conv-test'));

    await act(async () => { result.current.selectLanguage('en'); });
    const categoryPrompt = result.current.messages.find((m) => m.content.includes('select the type of issue'));
    expect(categoryPrompt).toBeTruthy();
  });
});

describe('useConversation — selectCategory', () => {
  test('sets selectedCategory', async () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.convId).toBe('conv-test'));
    await act(async () => { result.current.selectLanguage('en'); });

    await act(async () => { result.current.selectCategory('kyc_verification'); });
    expect(result.current.selectedCategory).toBe('kyc_verification');
  });

  test('adds user bubble with category opening message', async () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.convId).toBe('conv-test'));
    await act(async () => { result.current.selectLanguage('en'); });

    await act(async () => { result.current.selectCategory('kyc_verification'); });
    const userBubble = result.current.messages.find(
      (m) => m.role === 'user' && m.content.includes('KYC'),
    );
    expect(userBubble).toBeTruthy();
  });
});

describe('useConversation — send', () => {
  async function setupReady() {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.convId).toBe('conv-test'));
    await act(async () => { result.current.selectLanguage('en'); });
    await act(async () => { result.current.selectCategory('other'); });
    // Wait for selectCategory + intro send to complete (setCategoryAgent → setTimeout → sendMessage)
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 8000 });
    return result;
  }

  test('adds user bubble immediately', async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.send('hello world');
    });
    expect(result.current.messages.some((m) => m.role === 'user' && m.content === 'hello world')).toBe(true);
  });

  test('noop on empty string', async () => {
    const result = await setupReady();
    const before = result.current.messages.length;
    await act(async () => { await result.current.send('   '); });
    expect(result.current.messages.length).toBe(before);
  });

  test('sets error on API failure', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/chat/message')) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      }
      const key = Object.keys(defaultMocks).find((k) => url.includes(k));
      const body = key ? defaultMocks[key] : {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }) as jest.Mock;

    const result = await setupReady();
    await act(async () => { await result.current.send('trigger error'); });
    expect(result.current.error).toBeTruthy();
  });
});

describe('useConversation — reset', () => {
  test('clears all state', async () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.convId).toBe('conv-test'));
    await act(async () => { result.current.selectLanguage('th'); });

    await act(async () => { result.current.reset(); });
    expect(result.current.lang).toBe('en');
    expect(result.current.langSelected).toBe(false);
    expect(result.current.selectedCategory).toBeNull();
    expect(result.current.convId).toBeNull();
  });
});

describe('useConversation — submitCsat', () => {
  test('marks csatSubmitted=true after successful call', async () => {
    const { result } = renderHook(() => useConversation(cfg, localStorageAdapter));
    await waitFor(() => expect(result.current.convId).toBe('conv-test'));

    await act(async () => { await result.current.submitCsat(5); });
    expect(result.current.csatSubmitted).toBe(true);
    expect(result.current.csatPending).toBe(false);
  });
});
