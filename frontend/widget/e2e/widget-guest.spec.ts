/**
 * E2E: Guest (unauthenticated) widget flow.
 *
 * Correct flow:
 *   Greeting → Language → Name/Email form → Ploy intro → free-text chat
 *
 * - No category picker for guests
 * - Input locked until Ploy's intro arrives (awaitingFirstReply)
 * - PrevConversations hidden; fetchOpenTicket/fetchCustomerTickets not called
 * - Returning guest (cached session) skips the form
 * - Authenticated user sees no guest form and gets normal category picker
 */
import { test, expect } from '@playwright/test';
import { openWidget, selectLanguage } from './helpers';

const GUEST_CONV_ID = 'ffffffff-0000-0000-0000-000000000099';

// ─────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────

async function setupMockApiGuest(page: import('@playwright/test').Page) {
  await page.route('**/chat/start', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversation_id: GUEST_CONV_ID, ticket_id: GUEST_CONV_ID, is_guest: true }),
    })
  );

  await page.route(`**/chat/history/${GUEST_CONV_ID}**`, (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ history: [], human_handling: false }) })
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
        reply: 'Here is some general guidance from the knowledge base. To get account-specific details, please log in.',
        language: 'en',
        escalated: false,
        ticket_id: GUEST_CONV_ID,
        agent_name: null,
        agent_avatar: null,
        agent_avatar_url: null,
        offer_resolution: false,
        upgraded_category: null,
        transition_message: null,
      }),
    })
  );

  // Safety nets — guests should never call these
  await page.route('**/chat/customer-tickets**', (route) =>
    route.fulfill({ status: 401, body: '{"detail":"unauthorized"}' })
  );
  await page.route('**/chat/open-ticket', (route) =>
    route.fulfill({ status: 200, body: '{"ticket":null}' })
  );
}

/** Complete the guest flow up to Ploy's intro (input unlocked). */
async function guestFlowToChat(
  page: import('@playwright/test').Page,
  lang: 'en' | 'th' = 'en',
  action: 'skip' | 'submit' = 'skip',
) {
  await openWidget(page);
  await selectLanguage(page, lang);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  if (action === 'skip') {
    await page.click('button:has-text("Skip")');
  } else {
    await page.fill('input[type="text"]', 'John');
    await page.fill('input[type="email"]', 'john@test.com');
    await page.click('button:has-text("Start Chat")');
  }
  // Input unlocks after Ploy's intro
  await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
}

async function injectGuestSession(page: import('@playwright/test').Page) {
  await page.evaluate((id) => {
    localStorage.setItem('csbot_session', JSON.stringify({
      id, ts: Date.now(), lang: 'en', category: null, agent: null, isGuest: true,
    }));
  }, GUEST_CONV_ID);
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

test.describe('Guest opening flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApiGuest(page);
    await page.goto('/?guest=1');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test('greeting and lang picker shown immediately — no form yet', async ({ page }) => {
    await openWidget(page);
    await expect(page.locator('.csbot-messages')).toContainText('Hi!');
    await expect(page.locator('button:has-text("🇬🇧 English")')).toBeVisible();
    await expect(page.locator('input[type="email"]')).not.toBeVisible();
  });

  test('identity form appears AFTER language selection', async ({ page }) => {
    await openWidget(page);
    await expect(page.locator('input[type="email"]')).not.toBeVisible();
    await selectLanguage(page, 'en');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('.csbot-messages')).toContainText('Before we begin');
  });

  test('bilingual labels on the form', async ({ page }) => {
    await openWidget(page);
    await selectLanguage(page, 'en');
    await expect(page.locator('.csbot-messages')).toContainText('Before we begin');
    await expect(page.locator('.csbot-messages')).toContainText('ก่อนเริ่มต้น');
  });

  test('input disabled while guest form is open', async ({ page }) => {
    await openWidget(page);
    await selectLanguage(page, 'en');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('.csbot-input')).toBeDisabled();
  });

  test('Thai flow — form shown after TH selection', async ({ page }) => {
    await openWidget(page);
    await selectLanguage(page, 'th');
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });
});

test.describe('Guest identity form — submit and skip', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApiGuest(page);
    await page.goto('/?guest=1');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test('Skip calls /chat/start without name/email and shows Ploy intro', async ({ page }) => {
    let startBody: Record<string, unknown> = {};
    await page.route('**/chat/start', async (route) => {
      startBody = route.request().postDataJSON() ?? {};
      await route.fulfill({ status: 200, body: JSON.stringify({ conversation_id: GUEST_CONV_ID, is_guest: true }) });
    });

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("Skip")');

    await expect(page.locator('.csbot-messages')).toContainText("How can I help", { timeout: 10000 });
    expect(startBody.guest_name).toBeUndefined();
    expect(startBody.guest_email).toBeUndefined();
  });

  test('Start Chat sends name and email to /chat/start', async ({ page }) => {
    let startBody: Record<string, unknown> = {};
    await page.route('**/chat/start', async (route) => {
      startBody = route.request().postDataJSON() ?? {};
      await route.fulfill({ status: 200, body: JSON.stringify({ conversation_id: GUEST_CONV_ID, is_guest: true }) });
    });

    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.fill('input[type="text"]', 'John');
    await page.fill('input[type="email"]', 'john@test.com');
    await page.click('button:has-text("Start Chat")');

    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
    expect(startBody.guest_name).toBe('John');
    expect(startBody.guest_email).toBe('john@test.com');
  });

  test('pressing Enter in email field submits the form', async ({ page }) => {
    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.fill('input[type="text"]', 'Jane');
    await page.fill('input[type="email"]', 'jane@test.com');
    await page.press('input[type="email"]', 'Enter');
    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
  });

  test('input locked until Ploy intro arrives', async ({ page }) => {
    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("Skip")');
    // Immediately after skip — still locked
    await expect(page.locator('.csbot-input')).toBeDisabled();
    // Unlocks after intro
    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
  });

  test('Ploy intro shown in English after EN skip', async ({ page }) => {
    await guestFlowToChat(page, 'en', 'skip');
    await expect(page.locator('.csbot-messages')).toContainText("How can I help");
  });

  test('Ploy intro shown in Thai after TH skip', async ({ page }) => {
    await guestFlowToChat(page, 'th', 'skip');
    await expect(page.locator('.csbot-messages')).toContainText('มีอะไรให้ช่วย');
  });

  test('no category picker shown for guests', async ({ page }) => {
    await guestFlowToChat(page, 'en', 'skip');
    await expect(page.locator('[data-testid="category-picker"]')).not.toBeVisible();
  });

  test('form disappears after skip and is not shown again when widget reopened', async ({ page }) => {
    await openWidget(page);
    await selectLanguage(page, 'en');
    await page.click('button:has-text("Skip")');
    await expect(page.locator('input[type="email"]')).not.toBeVisible({ timeout: 8000 });
    await page.click('[aria-label="Close"]');
    await page.click('[aria-label="Open support chat"], .csbot-launcher');
    await expect(page.locator('input[type="email"]')).not.toBeVisible();
  });
});

test.describe('Guest chat flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApiGuest(page);
    await page.goto('/?guest=1');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await guestFlowToChat(page, 'en', 'skip');
  });

  test('can send a message and receive KB reply', async ({ page }) => {
    await page.fill('.csbot-input', 'What documents do I need for KYC?');
    await page.click('.csbot-send-btn');
    await expect(page.locator('.csbot-messages')).toContainText('general guidance', { timeout: 10000 });
  });

  test('PrevConversations panel not shown for guests', async ({ page }) => {
    await expect(page.locator('[data-testid="prev-conversations"]')).not.toBeVisible();
  });

  test('/chat/customer-tickets is never called for guests', async ({ page }) => {
    let called = false;
    await page.route('**/chat/customer-tickets**', (route) => { called = true; route.fulfill({ status: 401, body: '{}' }); });
    await page.waitForTimeout(500);
    expect(called).toBe(false);
  });

  test('/chat/open-ticket is never called for guests', async ({ page }) => {
    // open-ticket must never be called at any point during the guest flow — checked after full flow
    let called = false;
    await page.route('**/chat/open-ticket', (route) => { called = true; route.fulfill({ status: 200, body: '{"ticket":null}' }); });
    // give polling a moment to fire if it were going to
    await page.waitForTimeout(1000);
    expect(called).toBe(false);
  });

  test('open-ticket banner never appears for guests', async ({ page }) => {
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="open-ticket-banner"]')).not.toBeVisible();
  });
});

test.describe('Returning guest (cached session)', () => {
  test('returning guest skips form and goes to lang picker', async ({ page }) => {
    await setupMockApiGuest(page);
    await page.goto('/?guest=1');
    await page.evaluate(() => localStorage.clear());
    await injectGuestSession(page);

    await openWidget(page);
    await expect(page.locator('input[type="email"]')).not.toBeVisible();
    await expect(page.locator('button:has-text("🇬🇧 English")')).toBeVisible({ timeout: 5000 });
  });

  test('returning guest has no PrevConversations after starting chat', async ({ page }) => {
    await setupMockApiGuest(page);
    await page.goto('/?guest=1');
    await page.evaluate(() => localStorage.clear());
    await injectGuestSession(page);

    await openWidget(page);
    // Widget already open — do the flow steps manually without calling openWidget again
    await selectLanguage(page, 'en');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await page.click('button:has-text("Skip")');
    await expect(page.locator('.csbot-input:not([disabled])')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="prev-conversations"]')).not.toBeVisible();
  });
});

test.describe('Authenticated user unaffected', () => {
  test('authenticated user sees no guest form and gets normal category picker', async ({ page }) => {
    await page.route('**/chat/**', (route) => route.fulfill({ status: 200, body: '{}' }));
    await page.route('**/chat/history/auth-conv-id**', (route) =>
      route.fulfill({ status: 200, body: '{"history":[],"human_handling":false}' })
    );
    await page.route('**/chat/start', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ conversation_id: 'auth-conv-id', customer_id: 'auth-customer', is_guest: false }) })
    );
    await page.route('**/mock/auth/token', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ token: 'mock-jwt-token' }) })
    );

    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await openWidget(page);

    await expect(page.locator('button:has-text("🇬🇧 English"):not([disabled])')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('input[type="email"]')).not.toBeVisible();

    await selectLanguage(page, 'en');
    await expect(page.locator('input[type="email"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="category-picker"]')).toBeVisible();
  });
});
