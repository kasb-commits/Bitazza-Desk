import { ConversationSocket } from '../src/ws';

// Minimal WebSocket mock
class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(public url: string) {
    allSockets.push(this);
  }

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
  triggerOpen() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  triggerMessage(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  triggerClose() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
}

const allSockets: MockWebSocket[] = [];

beforeAll(() => {
  (global as any).WebSocket = MockWebSocket;
});

beforeEach(() => {
  allSockets.length = 0;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function latestSocket() { return allSockets[allSockets.length - 1]; }

describe('ConversationSocket', () => {
  test('transitions to open state after connect + auth frame', () => {
    const sock = new ConversationSocket();
    const states: string[] = [];
    sock.onStateChange((s) => states.push(s));
    sock.connect('conv-1', 'http://api.test', 'my-token');

    const ws = latestSocket();
    expect(states).toContain('connecting');
    ws.triggerOpen();
    expect(states).toContain('open');
    expect(ws.sent[0]).toContain('"type":"auth"');
    expect(ws.sent[0]).toContain('"token":"my-token"');
  });

  test('sends null token for guest sessions', () => {
    const sock = new ConversationSocket();
    sock.connect('conv-2', 'http://api.test', null);
    latestSocket().triggerOpen();
    const frame = JSON.parse(latestSocket().sent[0]);
    expect(frame.token).toBeNull();
  });

  test('dispatches onMessage for new_message frames', () => {
    const sock = new ConversationSocket();
    const messages: unknown[] = [];
    sock.onMessage((m) => messages.push(m));
    sock.connect('conv-3', 'http://api.test');
    latestSocket().triggerOpen();

    const msg = { type: 'new_message', message: { id: 'm1', role: 'agent', content: 'hi', timestamp: 1 } };
    latestSocket().triggerMessage(msg);
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).type).toBe('new_message');
  });

  test('ignores malformed JSON frames without throwing', () => {
    const sock = new ConversationSocket();
    sock.onMessage(() => { throw new Error('should not be called'); });
    sock.connect('conv-4', 'http://api.test');
    latestSocket().triggerOpen();
    expect(() => latestSocket().onmessage?.({ data: 'not-json' })).not.toThrow();
  });

  test('schedules reconnect after unexpected close', () => {
    const sock = new ConversationSocket();
    const states: string[] = [];
    sock.onStateChange((s) => states.push(s));
    sock.connect('conv-5', 'http://api.test');
    const first = latestSocket();
    first.triggerOpen();
    first.triggerClose(); // simulate drop
    expect(states).toContain('reconnecting');
    // Advance timers to trigger reconnect
    jest.advanceTimersByTime(2000);
    expect(allSockets.length).toBe(2); // new socket created
  });

  test('disconnect stops reconnect and marks closed', () => {
    const sock = new ConversationSocket();
    const states: string[] = [];
    sock.onStateChange((s) => states.push(s));
    sock.connect('conv-6', 'http://api.test');
    latestSocket().triggerOpen();
    sock.disconnect();
    expect(states[states.length - 1]).toBe('closed');
    jest.advanceTimersByTime(60_000);
    expect(allSockets.length).toBe(1); // no reconnect
  });

  test('sends ping every 25s while open', () => {
    const sock = new ConversationSocket();
    sock.connect('conv-7', 'http://api.test');
    const ws = latestSocket();
    ws.triggerOpen();
    const authFrame = ws.sent.length; // 1 auth frame already sent
    jest.advanceTimersByTime(25_001);
    expect(ws.sent.length).toBe(authFrame + 1);
    expect(JSON.parse(ws.sent[authFrame])).toEqual({ type: 'ping' });
  });

  test('builds ws url by replacing http with ws', () => {
    const sock = new ConversationSocket();
    sock.connect('conv-8', 'http://api.example.com/api');
    expect(latestSocket().url).toBe('ws://api.example.com/api/ws/conv-8');
  });

  test('onMessage unsubscribe removes handler', () => {
    const sock = new ConversationSocket();
    const received: unknown[] = [];
    const unsub = sock.onMessage((m) => received.push(m));
    sock.connect('conv-9', 'http://api.test');
    latestSocket().triggerOpen();
    unsub();
    latestSocket().triggerMessage({ type: 'pong' });
    expect(received).toHaveLength(0);
  });
});
