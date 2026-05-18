import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Widget from './Widget';
import type { CSBotConfig } from './types';
import './index.css';

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
async function getDevToken(apiUrl: string): Promise<string> {
  let userId = sessionStorage.getItem(DEV_USER_KEY);
  if (!userId) {
    userId = MOCK_USER_IDS[Math.floor(Math.random() * MOCK_USER_IDS.length)];
    sessionStorage.setItem(DEV_USER_KEY, userId);
    // New user — clear any cached conversation so a fresh one is created
    localStorage.removeItem('csbot_session');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
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
    return data.token as string;
  } finally {
    clearTimeout(timeout);
  }
}

async function mount() {
  const rawCfg: CSBotConfig = (window as any).CSBotConfig ?? {
    platform: 'web',
    apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:8000',
  };

  // Inject a mock token when running in dev without a real JWT.
  // Skip when ?guest=1 is in the URL — lets devs test the guest widget flow locally.
  const forceGuest = new URLSearchParams(window.location.search).get('guest') === '1';
  if (forceGuest) {
    rawCfg.guestMode = true;
  } else if (!rawCfg.token) {
    try {
      rawCfg.token = await getDevToken(rawCfg.apiUrl);
    } catch (e) {
      console.warn('[csbot-dev] could not fetch mock token, falling back to unauthenticated', e);
    }
  }

  const container = document.createElement('div');
  container.id = 'csbot-root';
  document.body.appendChild(container);

  createRoot(container).render(
    <StrictMode>
      <Widget cfg={rawCfg} />
    </StrictMode>,
  );
}

function safeMount() {
  mount().catch((e) => console.error('[csbot] mount failed:', e));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', safeMount);
} else {
  safeMount();
}
