import { StrictMode, Component } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Widget from './Widget';
import type { CSBotConfig } from './types';
import { initWidgetSession } from './api';
import './index.css';

let _apiBase = '';

function sendClientLog(entry: Record<string, unknown>) {
  fetch(`${_apiBase}/api/logs/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'widget', entries: [entry] }),
  }).catch(() => {}); // fire-and-forget
}

class WidgetErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch(error: Error, info: { componentStack: string }) {
    sendClientLog({
      level: 'error',
      event: 'react_error_boundary',
      message: error.message,
      stack: error.stack,
      component: info.componentStack,
      url: window.location.href,
    });
  }
  render() {
    if (this.state.crashed) return (
      <div style={{ padding: 16, fontFamily: 'sans-serif', color: '#c00' }}>
        Chat unavailable. Please refresh the page.
      </div>
    );
    return this.props.children;
  }
}

// All 21 mock user IDs (dev_user + USR-000001 … USR-000020)
const MOCK_USER_IDS = [
  'USR-000001', 'USR-000002', 'USR-000003', 'USR-000004', 'USR-000005',
  'USR-000006', 'USR-000007', 'USR-000008', 'USR-000009', 'USR-000010',
  'USR-000011', 'USR-000012', 'USR-000013', 'USR-000014', 'USR-000015',
  'USR-000016', 'USR-000017', 'USR-000018', 'USR-000019', 'USR-000020',
];

const DEV_USER_KEY = 'csbot_dev_user_id';

/**
 * In dev (no token on window.CSBotConfig), pick a mock user and fetch a real
 * signed JWT for them. The same user is reused for the browser session so
 * the conversation persists across page refreshes — but on a fresh session
 * (sessionStorage cleared) a new random user is picked.
 *
 * In production Freedom/Bitazza sets window.CSBotConfig.token before the
 * widget loads — this function is never called.
 */
interface DevTokenResult {
  token: string;
  expiresAt: number; // ms since epoch
}

async function getDevToken(apiUrl: string): Promise<DevTokenResult> {
  let userId = sessionStorage.getItem(DEV_USER_KEY);
  if (!userId) {
    userId = MOCK_USER_IDS[Math.floor(Math.random() * MOCK_USER_IDS.length)];
    sessionStorage.setItem(DEV_USER_KEY, userId);
    // New user — clear any cached conversation so a fresh one is created
    localStorage.removeItem('csbot_session');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${apiUrl}/mock/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`mock token failed for ${userId}: ${res.status}`);
    const data = await res.json();
    console.debug(`[csbot-dev] signed in as mock user ${userId}`);
    const expiresAt = Date.now() + (data.expires_in as number) * 1000;
    return { token: data.token as string, expiresAt };
  } finally {
    clearTimeout(timeout);
  }
}

const BOOTSTRAP_MSG_TYPE = 'csbot_bootstrap';
const BOOTSTRAP_WAIT_MS = 8000;

/**
 * Bitazza Exchange handoff (Phase 2): when embedded as an iframe, the parent web
 * app posts the single-use bootstrap token after load. We validate event.origin
 * against allowedParentOrigins (when provided) before trusting any message — a
 * bootstrap from an unknown origin is dropped. Resolves null on timeout so the
 * caller can fall back. Also announces 'csbot_ready' so a parent that waits for
 * readiness knows when to post.
 */
function waitForBootstrapMessage(allowedOrigins?: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(val);
    };
    const onMessage = (event: MessageEvent) => {
      if (allowedOrigins && allowedOrigins.length > 0 && !allowedOrigins.includes(event.origin)) return;
      const data = event.data;
      if (data && data.type === BOOTSTRAP_MSG_TYPE && typeof data.token === 'string') {
        finish(data.token);
      }
    };
    const timer = setTimeout(() => finish(null), BOOTSTRAP_WAIT_MS);
    window.addEventListener('message', onMessage);
    try { window.parent.postMessage({ type: 'csbot_ready' }, '*'); } catch { /* ignore */ }
  });
}

async function mount() {
  const rawCfg: CSBotConfig = (window as any).CSBotConfig ?? {
    platform: 'web',
    apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:8000',
  };
  _apiBase = rawCfg.apiUrl;

  window.addEventListener('unhandledrejection', (e) => {
    sendClientLog({
      level: 'error',
      event: 'unhandled_rejection',
      message: e.reason instanceof Error ? e.reason.message : String(e.reason),
      stack: e.reason instanceof Error ? e.reason.stack : undefined,
      url: window.location.href,
    });
  });

  // Inject a mock token when running in dev without a real JWT.
  // Skip when ?guest=1 is in the URL — lets devs test the guest widget flow locally.
  const forceGuest = new URLSearchParams(window.location.search).get('guest') === '1';
  if (forceGuest) {
    rawCfg.guestMode = true;
  } else if (!rawCfg.token) {
    // Bitazza Exchange handoff: turn a single-use bootstrap into our session JWT.
    //   1) bootstrap provided synchronously on the config, or
    //   2) bootstrap delivered async via postMessage from the parent (iframe embed).
    // Falls back to the dev mock-token flow when no bootstrap is available.
    let bootstrap = rawCfg.wstBootstrap;
    if (!bootstrap && window.parent !== window) {
      bootstrap = (await waitForBootstrapMessage(rawCfg.allowedParentOrigins)) ?? undefined;
    }
    if (bootstrap) {
      try {
        const session = await initWidgetSession(bootstrap, rawCfg.apiUrl);
        rawCfg.token = session.token;
        rawCfg.tokenExpiresAt = session.tokenExpiresAt;
      } catch (e) {
        console.error('[csbot] bootstrap exchange failed', e);
        sendClientLog({ level: 'error', event: 'bootstrap_exchange_failed', message: e instanceof Error ? e.message : String(e) });
      }
    } else {
      // Dev fallback (unchanged): mint a mock token. No-op in prod (/mock absent).
      try {
        const result = await getDevToken(rawCfg.apiUrl);
        rawCfg.token = result.token;
        rawCfg.tokenExpiresAt = result.expiresAt;
        rawCfg.onTokenRefresh = async () => {
          const r = await getDevToken(rawCfg.apiUrl);
          rawCfg.tokenExpiresAt = r.expiresAt;
          return r.token;
        };
      } catch (e) {
        console.warn('[csbot-dev] could not fetch mock token, falling back to unauthenticated', e);
      }
    }
  }

  const container = document.createElement('div');
  container.id = 'csbot-root';
  document.body.appendChild(container);

  createRoot(container).render(
    <StrictMode>
      <WidgetErrorBoundary>
        <Widget cfg={rawCfg} />
      </WidgetErrorBoundary>
    </StrictMode>,
  );
}

function safeMount() {
  mount().catch((e) => {
    console.error('[csbot] mount failed:', e);
    sendClientLog({ level: 'error', event: 'widget_mount_failed', message: e instanceof Error ? e.message : String(e) });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', safeMount);
} else {
  safeMount();
}
