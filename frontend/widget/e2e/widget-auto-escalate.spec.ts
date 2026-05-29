/**
 * E2E: Auto-escalation on init failures.
 *
 * Written BEFORE implementation (TDD). All tests expected to fail until
 * the retry + emergency-escalate logic is built into api.ts / ChatWindow.tsx.
 *
 * Failure points in the widget:
 *   1. startConversation() — init useEffect
 *   2. setCategoryAgent()  — selectCategory callback
 *
 * Note: greetConversation is defined in api.ts but never called by the widget.
 * Note: sendMessage() failures are handled server-side (3x Gemini retry → escalated:true).
 *
 * Scenarios covered:
 *   A. startConversation: first call fails, retry succeeds → normal flow
 *   B. startConversation: both calls fail → emergency escalation → banner + input open
 *   C. startConversation: both fail + emergency fails → static fallback shown
 *   D. setCategoryAgent: first call fails, retry succeeds → normal flow
 *   E. setCategoryAgent: both calls fail → escalation banner shown + input open
 *   F. Regression: normal happy path unaffected
 */

import { test, expect } from '@playwright/test';
import { openWidget, selectLanguage, CONV_ID, TICKET_ID, CUSTOMER_ID } from './helpers';

const EMERGENCY_CONV_ID = 'eeee0000-0000-0000-0000-emergency001';

// ─── Shared mock helpers ──────────────────────────────────────────────────────

async function setupBaseRoutes(page: import('@playwright/test').Page) {
  await page.route('**/chat/history/**', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ history: [], human_handling: false }) })
  );
  await page.route('**/chat/open-ticket', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ ticket: null }) })
  );
  await page.route('**/chat/customer-tickets**', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ tickets: [] }) })
  );
  await page.route('**/chat/greet', (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ greeting: 'Hello!', bot_name: 'Ploy', agent_avatar_url: null }),
    })
  );
  await page.route('**/chat/set-category', (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ agent_name: 'Ploy', agent_avatar: 'P', agent_avatar_url: null }),
    })
  );
  await page.route('**/chat/message', (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({
        reply: 'How can I help?',
        language: 'en',
        escalated: false,
        ticket_id: TICKET_ID,
        agent_name: null,
        agent_avatar: null,
        agent_avatar_url: null,
        offer_resolution: false,
        upgraded_category: null,
        transition_message: null,
      }),
    })
  );
}

function emergencyResponse() {
  return JSON.stringify({
    conversation_id: EMERGENCY_CONV_ID,
    ticket_id: EMERGENCY_CONV_ID,
    escalated: true,
  });
}

function startResponse() {
  return JSON.stringify({
    conversation_id: CONV_ID,
    ticket_id: TICKET_ID,
    customer_id: CUSTOMER_ID,
    agent_name: 'Ploy',
    agent_avatar: 'P',
    agent_avatar_url: null,
    is_guest: false,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// A. startConversation: first call fails, retry succeeds → normal flow
// ═════════════════════════════════════════════════════════════════════════════

test.describe('A. startConversation — retry succeeds on second attempt', () => {
  test.beforeEach(async ({ page }) => {
    await setupBaseRoutes(page);
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test('widget shows greeting and lang picker after transient start failure', async ({ page }) => {
    let callCount = 0;
    await page.route('**/chat/start', (route) => {
      callCount++;
      if (callCount === 1) return route.fulfill({ status: 500, body: '{"detail":"server error"}' });
      return route.fulfill({ status: 200, body: startResponse() });
    });

    await openWidget(page);
    await expect(page.locator('.csbot-messages')).toContainText('Hi!', { timeout: 8000 });
    await expect(page.locator('button:has-text("🇬🇧 English")')).toBeVisible();
  });

  test('start is called exactly twice before succeeding', async ({ page }) => {
    let callCount = 0;
    await page.route('**/chat/start', (route) => {
      callCount++;
      if (callCount === 1) return route.fulfill({ status: 503, body: '{}' });
      return route.fulfill({ status: 200, body: startResponse() });
    });

    await openWidget(page);
    await expect(page.locator('button:has-text("🇬🇧 English")')).toBeVisible({ timeout: 8000 });
    expect(callCount).toBe(2);
  });

  test('no escalation banner shown when retry succeeds', async ({ page }) => {
    let callCount = 0;
    await page.route('**/chat/start', (route) => {
      callCount++;
      if (callCount === 1) return route.fulfill({ status: 500, body: '{}' });
      return route.fulfill({ status: 200, body: startResponse() });
    });

    await openWidget(page);
    await expect(page.locator('button:has-text("🇬🇧 English")')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.csbot-escalation-banner')).not.toBeVisible();
  });

  test('emergency endpoint NOT called when retry succeeds', async ({ page }) => {
    let emergencyCalled = false;
    await page.route('**/chat/emergency-escalate', () => { emergencyCalled = true; });

    let callCount = 0;
    await page.route('**/chat/start', (route) => {
      callCount++;
      if (callCount === 1) return route.fulfill({ status: 500, body: '{}' });
      return route.fulfill({ status: 200, body: startResponse() });
    });

    await openWidget(page);
    await expect(page.locator('button:has-text("🇬🇧 English")')).toBeVisible({ timeout: 8000 });
    expect(emergencyCalled).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. startConversation: both fail → emergency escalation → banner + input open
// ═════════════════════════════════════════════════════════════════════════════

test.describe('B. startConversation — both attempts fail → emergency escalation', () => {
  test.beforeEach(async ({ page }) => {
    await setupBaseRoutes(page);
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test('escalation banner appears after both start attempts fail', async ({ page }) => {
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 200, body: emergencyResponse() })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
  });

  test('escalation banner shows correct English text', async ({ page }) => {
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 200, body: emergencyResponse() })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-escalation-banner')).toContainText(
      'Connecting you to a support agent', { timeout: 10000 }
    );
  });

  test('input remains enabled after emergency escalation', async ({ page }) => {
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 200, body: emergencyResponse() })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.csbot-input')).not.toBeDisabled();
  });

  test('loading state cleared after emergency escalation', async ({ page }) => {
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 200, body: emergencyResponse() })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    // No spinner / loading indicator visible
    await expect(page.locator('[data-testid="typing-indicator"]')).not.toBeVisible();
  });

  test('emergency endpoint called with error_source start_failed', async ({ page }) => {
    let capturedBody: Record<string, unknown> | null = null;
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({ status: 200, body: emergencyResponse() });
    });

    await openWidget(page);
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    expect(capturedBody?.error_source).toBe('start_failed');
  });

  test('start called exactly twice before falling through to emergency', async ({ page }) => {
    let startCount = 0;
    await page.route('**/chat/start', (route) => {
      startCount++;
      return route.fulfill({ status: 500, body: '{}' });
    });
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 200, body: emergencyResponse() })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    expect(startCount).toBe(2);
  });

  test('customer can type after emergency escalation completes', async ({ page }) => {
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 200, body: emergencyResponse() })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    await page.fill('.csbot-input', 'I cannot log in');
    await expect(page.locator('.csbot-input')).toHaveValue('I cannot log in');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. startConversation: both fail + emergency fails → static fallback
// ═════════════════════════════════════════════════════════════════════════════

test.describe('C. startConversation — all paths fail → static fallback', () => {
  test.beforeEach(async ({ page }) => {
    await setupBaseRoutes(page);
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test('static fallback message shown when everything fails', async ({ page }) => {
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-messages')).toContainText(
      'support@bitazza.com', { timeout: 10000 }
    );
  });

  test('fallback message does not show escalation banner', async ({ page }) => {
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-messages')).toContainText('support@bitazza.com', { timeout: 10000 });
    await expect(page.locator('.csbot-escalation-banner')).not.toBeVisible();
  });

  test('Thai fallback shown when lang is th', async ({ page }) => {
    // Thai fallback: pre-set lang to 'th' via widget config URL param
    await page.goto('/?lang=th');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );
    await page.route('**/chat/emergency-escalate', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );

    await openWidget(page);
    await expect(page.locator('.csbot-messages')).toContainText(
      'support@bitazza.com', { timeout: 10000 }
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. setCategoryAgent: first call fails, retry succeeds → normal flow
// ═════════════════════════════════════════════════════════════════════════════

test.describe('D. setCategoryAgent — retry succeeds on second attempt', () => {
  test.beforeEach(async ({ page }) => {
    await setupBaseRoutes(page);
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 200, body: startResponse() })
    );
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test('chat input unlocks normally after transient set-category failure', async ({ page }) => {
    let callCount = 0;
    await page.route('**/chat/set-category', (route) => {
      callCount++;
      if (callCount === 1) return route.fulfill({ status: 500, body: '{}' });
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ agent_name: 'Ploy', agent_avatar: 'P', agent_avatar_url: null }),
      });
    });

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
  });

  test('no escalation banner shown when set-category retry succeeds', async ({ page }) => {
    let callCount = 0;
    await page.route('**/chat/set-category', (route) => {
      callCount++;
      if (callCount === 1) return route.fulfill({ status: 500, body: '{}' });
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ agent_name: 'Ploy', agent_avatar: 'P', agent_avatar_url: null }),
      });
    });

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.csbot-escalation-banner')).not.toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. setCategoryAgent: both calls fail → escalation banner + input open
// ═════════════════════════════════════════════════════════════════════════════

test.describe('E. setCategoryAgent — both attempts fail → escalate existing ticket', () => {
  test.beforeEach(async ({ page }) => {
    await setupBaseRoutes(page);
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 200, body: startResponse() })
    );
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test('escalation banner shown after both set-category attempts fail', async ({ page }) => {
    await page.route('**/chat/set-category', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
  });

  test('input stays open after set-category escalation', async ({ page }) => {
    await page.route('**/chat/set-category', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.csbot-input')).not.toBeDisabled();
  });

  test('set-category called exactly twice before escalation', async ({ page }) => {
    let callCount = 0;
    await page.route('**/chat/set-category', (route) => {
      callCount++;
      return route.fulfill({ status: 500, body: '{}' });
    });

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    expect(callCount).toBe(2);
  });

  test('emergency endpoint NOT called for set-category failure (ticket already exists)', async ({ page }) => {
    let emergencyCalled = false;
    await page.route('**/chat/emergency-escalate', () => { emergencyCalled = true; });
    await page.route('**/chat/set-category', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    expect(emergencyCalled).toBe(false);
  });

  test('customer can type a message after set-category escalation', async ({ page }) => {
    await page.route('**/chat/set-category', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    );

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-escalation-banner')).toBeVisible({ timeout: 10000 });
    await page.fill('.csbot-input', 'My KYC was rejected');
    await expect(page.locator('.csbot-input')).toHaveValue('My KYC was rejected');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. Regression — normal happy path unaffected
// ═════════════════════════════════════════════════════════════════════════════

test.describe('F. Regression — normal flow unaffected', () => {
  test.beforeEach(async ({ page }) => {
    await setupBaseRoutes(page);
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 200, body: startResponse() })
    );
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test('normal start → lang → category → chat flow works end-to-end', async ({ page }) => {
    await openWidget(page);
    await expect(page.locator('button:has-text("🇬🇧 English")')).toBeVisible({ timeout: 8000 });
    await selectLanguage(page, 'en');
    await expect(page.locator('[data-testid="category-picker"]')).toBeVisible();
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
  });

  test('no escalation banner on normal flow', async ({ page }) => {
    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.csbot-escalation-banner')).not.toBeVisible();
  });

  test('emergency endpoint never called on normal flow', async ({ page }) => {
    let emergencyCalled = false;
    await page.route('**/chat/emergency-escalate', () => { emergencyCalled = true; });

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("KYC")');
    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
    expect(emergencyCalled).toBe(false);
  });

  test('start called exactly once on normal flow', async ({ page }) => {
    let startCount = 0;
    await page.route('**/chat/start', (route) => {
      startCount++;
      return route.fulfill({ status: 200, body: startResponse() });
    });

    await openWidget(page);
    await expect(page.locator('button:has-text("🇬🇧 English")')).toBeVisible({ timeout: 8000 });
    expect(startCount).toBe(1);
  });
});
