import {
  startConversation, greetConversation, setCategoryAgent, sendMessage,
  fetchHistory, fetchCustomerTickets, fetchOpenTicket, submitCsat,
  fetchAnnouncements, emergencyEscalate, sendClientLog,
} from '../src/api';
import { localStorageAdapter } from '../src/storage';
import type { CSBotSDKConfig } from '../src/types';

const cfg: CSBotSDKConfig = {
  platform: 'bitazza',
  apiUrl: 'http://localhost:8001',
  supportedLanguages: ['en', 'th'],
};

const adapter = localStorageAdapter;

beforeEach(() => {
  localStorage.clear();
  jest.resetAllMocks();
});

function mockFetch(body: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

describe('startConversation', () => {
  test('calls /chat/start and returns conversation_id', async () => {
    mockFetch({ conversation_id: 'conv-abc', is_guest: false });
    const id = await startConversation(cfg, adapter);
    expect(id).toBe('conv-abc');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/chat/start',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('returns cached session on second call', async () => {
    mockFetch({ conversation_id: 'conv-cached', is_guest: false });
    const id1 = await startConversation(cfg, adapter);
    const id2 = await startConversation(cfg, adapter);
    expect(id1).toBe(id2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('greetConversation', () => {
  test('returns greeting, botName, botAvatarUrl', async () => {
    mockFetch({ greeting: 'Hello!', bot_name: 'Aria', agent_avatar_url: null });
    const result = await greetConversation(cfg, 'conv-1', 'en');
    expect(result.greeting).toBe('Hello!');
    expect(result.botName).toBe('Aria');
    expect(result.botAvatarUrl).toBeNull();
  });
});

describe('setCategoryAgent', () => {
  test('returns agent identity from response', async () => {
    mockFetch({ agent_name: 'Ploy', agent_avatar: 'P', agent_avatar_url: '/avatars/ploy.png' });
    const result = await setCategoryAgent(cfg, 'conv-1', 'kyc_verification');
    expect(result.agentName).toBe('Ploy');
    expect(result.agentAvatar).toBe('P');
  });
});

describe('sendMessage', () => {
  test('returns full SendResult', async () => {
    mockFetch({
      reply: 'I can help with that.',
      language: 'en',
      escalated: false,
      ticket_id: 't-1',
      offer_resolution: false,
      quick_replies: ['Yes', 'No'],
    });
    const result = await sendMessage(cfg, 'conv-1', 'Hello');
    expect(result.reply).toBe('I can help with that.');
    expect(result.quickReplies).toEqual(['Yes', 'No']);
    expect(result.escalated).toBe(false);
  });

  test('throws on non-ok response', async () => {
    mockFetch({}, 500);
    await expect(sendMessage(cfg, 'conv-1', 'test')).rejects.toThrow('message failed: 500');
  });
});

describe('fetchHistory', () => {
  test('returns messages and flags', async () => {
    mockFetch({ history: [{ role: 'user', content: 'hi', created_at: 1000 }], human_handling: false, ticket_status: 'Open_Live' });
    const result = await fetchHistory(cfg, 'conv-1');
    expect(result.messages).toHaveLength(1);
    expect(result.ticketStatus).toBe('Open_Live');
  });

  test('returns empty on error', async () => {
    mockFetch({}, 404);
    const result = await fetchHistory(cfg, 'bad-id');
    expect(result.messages).toHaveLength(0);
  });
});

describe('fetchCustomerTickets', () => {
  test('maps ticket fields correctly', async () => {
    mockFetch({ tickets: [{ id: 't1', category: 'kyc_verification', status: 'Open_Live', created_at: 1000, last_message: 'hi', last_message_at: 2000 }] });
    const tickets = await fetchCustomerTickets(cfg);
    expect(tickets[0].id).toBe('t1');
    expect(tickets[0].category).toBe('kyc_verification');
    expect(tickets[0].lastMessage).toBe('hi');
  });
});

describe('fetchOpenTicket', () => {
  test('returns null when no ticket', async () => {
    mockFetch({ ticket: null });
    expect(await fetchOpenTicket(cfg)).toBeNull();
  });
});

describe('submitCsat', () => {
  test('makes POST to /chat/csat', async () => {
    mockFetch({});
    await submitCsat(cfg, 't-1', 5);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/chat/csat',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('fetchAnnouncements', () => {
  test('maps announcement fields', async () => {
    mockFetch({ announcements: [{ id: 'a1', title_en: 'Hi', body_en: 'Body', title_th: 'สวัสดี', body_th: 'เนื้อหา', color: '#ff0000' }] });
    const anns = await fetchAnnouncements(cfg);
    expect(anns[0].id).toBe('a1');
    expect(anns[0].titleEn).toBe('Hi');
    expect(anns[0].color).toBe('#ff0000');
  });

  test('returns empty array on error', async () => {
    mockFetch({}, 500);
    expect(await fetchAnnouncements(cfg)).toEqual([]);
  });
});

describe('emergencyEscalate', () => {
  test('returns conversationId and ticketId', async () => {
    mockFetch({ conversation_id: 'conv-e', ticket_id: 'tkt-e' });
    const result = await emergencyEscalate(cfg, 'test_error');
    expect(result.conversationId).toBe('conv-e');
    expect(result.ticketId).toBe('tkt-e');
  });
});

describe('sendClientLog', () => {
  test('fires-and-forgets without throwing', () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;
    expect(() => sendClientLog('http://localhost:8001', { level: 'info', event: 'test' })).not.toThrow();
  });
});
