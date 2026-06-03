/**
 * E2E: "Go back" (header back arrow) and "Request human support" pill.
 *
 * Back arrow:
 *   - Appears in header after category is selected, before escalation
 *   - Hidden before category selection, hidden after escalation
 *   - Clicking it resets to greeting + category picker
 *
 * Request human support pill:
 *   - Appears between messages and input after category selected + not escalated
 *   - Hidden before category selection, hidden during loading, hidden after escalation
 *   - Clicking it sends the escalation phrase → backend escalates → pill disappears
 */
import { test, expect } from '@playwright/test';
import { openWidget, selectLanguage, selectCategory, setupMockApiNewUser } from './helpers';

test.beforeEach(async ({ page }) => {
  await setupMockApiNewUser(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

// ─── Back arrow visibility ────────────────────────────────────────────────────

test('back arrow is hidden before category is selected', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'en');
  await expect(page.locator('[aria-label="Go back to topics"]')).not.toBeVisible();
});

test('back arrow appears in header after category is selected', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'en');
  await selectCategory(page, 'KYC');
  await expect(page.locator('[aria-label="Go back to topics"]')).toBeVisible();
});

test('back arrow is hidden once a human agent connects', async ({ page }) => {
  // Simulate escalation: message route returns escalated=true with an agent name,
  // which causes escalatedAgent to be populated via the poll or response path.
  await page.route('**/chat/message', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        reply: 'Connecting you to an agent.',
        language: 'en',
        escalated: true,
        ticket_id: 'bbbbbbbb-0000-0000-0000-000000000001',
        agent_name: 'Aria',
        agent_avatar: 'A',
        agent_avatar_url: null,
        offer_resolution: false,
        upgraded_category: null,
        transition_message: null,
      }),
    })
  );
  // Override history to return an agent message so escalatedAgent gets populated
  await page.route(`**/chat/history/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        history: [{
          role: 'agent', content: 'Hi, I am Aria!',
          created_at: Math.floor(Date.now() / 1000),
          agent_name: 'Aria', agent_avatar: 'A', agent_avatar_url: null,
        }],
        human_handling: true,
      }),
    })
  );
  await openWidget(page);
  await selectLanguage(page, 'en');
  await selectCategory(page, 'KYC');
  await page.fill('.csbot-input', 'I need a human');
  await page.press('.csbot-input', 'Enter');
  // Wait for agent connected banner or escalatedAgent state
  await page.waitForTimeout(4000); // allow poll cycle to fire
  await expect(page.locator('[aria-label="Go back to topics"]')).not.toBeVisible();
});

// ─── Go back behaviour ────────────────────────────────────────────────────────

test('clicking back arrow resets to category picker', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'en');
  await selectCategory(page, 'KYC');
  await expect(page.locator('[data-testid="category-picker"]')).not.toBeVisible();

  await page.click('[aria-label="Go back to topics"]');

  await expect(page.locator('[data-testid="category-picker"]')).toBeVisible();
  await expect(page.locator('[aria-label="Go back to topics"]')).not.toBeVisible();
});

test('after going back, input is disabled again', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'en');
  await selectCategory(page, 'KYC');
  await page.click('[aria-label="Go back to topics"]');
  await expect(page.locator('.csbot-input')).toBeDisabled();
});

test('after going back, greeting message is shown', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'en');
  await selectCategory(page, 'KYC');
  await page.click('[aria-label="Go back to topics"]');
  await expect(page.locator('.csbot-messages')).toContainText('Hi!');
});

test('can select a new category after going back', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'en');
  await selectCategory(page, 'KYC');
  await page.click('[aria-label="Go back to topics"]');
  await selectCategory(page, 'Account');
  await expect(page.locator('.csbot-input')).not.toBeDisabled();
  await expect(page.locator('[aria-label="Go back to topics"]')).toBeVisible();
});

// ─── Escalation pill visibility ───────────────────────────────────────────────

test('escalation pill is hidden before category is selected', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'en');
  await expect(page.locator('button:has-text("Request human support")')).not.toBeVisible();
});

test('escalation pill appears after category is selected', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'en');
  await selectCategory(page, 'KYC');
  await expect(page.locator('button:has-text("Request human support")')).toBeVisible();
});

test('escalation pill disappears once a human agent connects', async ({ page }) => {
  await page.route('**/chat/message', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        reply: 'Connecting you to an agent.',
        language: 'en',
        escalated: true,
        ticket_id: 'bbbbbbbb-0000-0000-0000-000000000001',
        agent_name: 'Aria',
        agent_avatar: 'A',
        agent_avatar_url: null,
        offer_resolution: false,
        upgraded_category: null,
        transition_message: null,
      }),
    })
  );
  await page.route(`**/chat/history/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        history: [{
          role: 'agent', content: 'Hi, I am Aria!',
          created_at: Math.floor(Date.now() / 1000),
          agent_name: 'Aria', agent_avatar: 'A', agent_avatar_url: null,
        }],
        human_handling: true,
      }),
    })
  );
  await openWidget(page);
  await selectLanguage(page, 'en');
  await selectCategory(page, 'KYC');
  await page.fill('.csbot-input', 'I need a human');
  await page.press('.csbot-input', 'Enter');
  await page.waitForTimeout(4000);
  await expect(page.locator('button:has-text("Request human support")')).not.toBeVisible();
});

// ─── Escalation pill — Thai ───────────────────────────────────────────────────

test('escalation pill shows Thai label in Thai mode', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'th');
  await selectCategory(page, 'KYC');
  await expect(page.locator('button:has-text("ขอติดต่อเจ้าหน้าที่")')).toBeVisible();
  await expect(page.locator('button:has-text("Request human support")')).not.toBeVisible();
});

// ─── Back arrow — Thai ────────────────────────────────────────────────────────

test('back arrow shows in Thai mode', async ({ page }) => {
  await openWidget(page);
  await selectLanguage(page, 'th');
  await selectCategory(page, 'KYC');
  await expect(page.locator('[aria-label="Go back to topics"]')).toBeVisible();
});
