import type { WsInboundMessage, WsOutboundMessage, WsConnectionState } from './types';

const PING_INTERVAL_MS = 25_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const FALLBACK_POLL_THRESHOLD_MS = 10_000;

export class ConversationSocket {
  private _ws: WebSocket | null = null;
  private _convId: string | null = null;
  private _apiUrl: string | null = null;
  private _token: string | null = null;
  private _state: WsConnectionState = 'closed';
  private _intentionalClose = false;
  private _reconnectAttempt = 0;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private _handlers: ((msg: WsInboundMessage) => void)[] = [];
  private _stateHandlers: ((state: WsConnectionState) => void)[] = [];
  private _fallbackPoll: (() => void) | null = null;
  private _fallbackInterval: ReturnType<typeof setInterval> | null = null;
  private _reconnectingAt: number | null = null;

  get state(): WsConnectionState {
    return this._state;
  }

  onMessage(handler: (msg: WsInboundMessage) => void): () => void {
    this._handlers.push(handler);
    return () => { this._handlers = this._handlers.filter((h) => h !== handler); };
  }

  onStateChange(handler: (state: WsConnectionState) => void): () => void {
    this._stateHandlers.push(handler);
    return () => { this._stateHandlers = this._stateHandlers.filter((h) => h !== handler); };
  }

  setFallbackPoll(fn: () => void): void {
    this._fallbackPoll = fn;
  }

  connect(convId: string, apiUrl: string, token: string | null = null): void {
    this._convId = convId;
    this._apiUrl = apiUrl;
    this._token = token;
    this._intentionalClose = false;
    this._reconnectAttempt = 0;
    this._open();
  }

  disconnect(): void {
    this._intentionalClose = true;
    this._clearTimers();
    this._stopFallback();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._setState('closed');
  }

  send(msg: WsOutboundMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  private _open(): void {
    if (!this._convId || !this._apiUrl) return;
    const wsUrl = this._apiUrl.replace(/^http/, 'ws') + `/ws/${this._convId}`;
    this._setState('connecting');
    const ws = new WebSocket(wsUrl);
    this._ws = ws;

    ws.onopen = () => {
      // Auth handshake — send token (or null for guests)
      ws.send(JSON.stringify({ type: 'auth', token: this._token }));
      this._setState('open');
      this._reconnectAttempt = 0;
      this._stopFallback();
      this._clearReconnectTimer();
      this._startPing();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsInboundMessage;
        this._handlers.forEach((h) => h(msg));
      } catch { /* malformed frame — ignore */ }
    };

    ws.onclose = () => {
      this._clearPing();
      if (this._intentionalClose) return;
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // onerror always precedes onclose — let onclose drive reconnect
    };
  }

  private _scheduleReconnect(): void {
    this._setState('reconnecting');
    this._reconnectingAt = Date.now();

    // Start fallback polling after threshold
    this._fallbackTimer = setTimeout(() => {
      this._startFallback();
    }, FALLBACK_POLL_THRESHOLD_MS);

    const delayMs = RECONNECT_DELAYS_MS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(() => {
      if (!this._intentionalClose) this._open();
    }, delayMs);
  }

  private _startPing(): void {
    this._pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private _startFallback(): void {
    if (!this._fallbackPoll || this._fallbackInterval) return;
    this._fallbackInterval = setInterval(this._fallbackPoll, 5000);
  }

  private _stopFallback(): void {
    if (this._fallbackInterval) {
      clearInterval(this._fallbackInterval);
      this._fallbackInterval = null;
    }
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
  }

  private _clearPing(): void {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  private _clearTimers(): void {
    this._clearPing();
    this._clearReconnectTimer();
  }

  private _setState(state: WsConnectionState): void {
    this._state = state;
    this._stateHandlers.forEach((h) => h(state));
  }
}
