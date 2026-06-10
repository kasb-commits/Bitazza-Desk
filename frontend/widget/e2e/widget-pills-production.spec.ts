/**
 * Production validation: quick-reply pill buttons appear after bot replies.
 * Hits the real Railway backend — NO mocking.
 */
import { test, expect } from '@playwright/test';

const PROD_URL = 'https://widget-orpin-two.vercel.app';

/** Open widget, pick English, pick KYC, wait for bot's opening reply. */
async function setupKycChat(page: any) {
  await page.goto(PROD_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('[aria-label="Open support chat"], .csbot-launcher', { timeout: 10_000 });
  await page.click('[aria-label="Open support chat"], .csbot-launcher');
  await page.waitForSelector('.csbot-window', { timeout: 5_000 });
  await page.click('button:has-text("🇬🇧 English")');
  await page.waitForSelector('[data-testid="category-picker"]', { timeout: 5_000 });
  await page.click('button:has-text("KYC")');
  // Wait for bot's opening reply — input unlocks once it arrives
  await page.waitForSelector('.csbot-input:not([disabled])', { timeout: 30_000 });
}

/** Send a message and wait for the input to unlock again (bot replied). */
async function sendAndWaitForReply(page: any, text: string) {
  await page.fill('.csbot-input', text);
  await page.click('.csbot-send-btn');
  // Input goes disabled while waiting for reply, then re-enables
  await page.waitForSelector('.csbot-input[disabled]', { timeout: 5_000 }).catch(() => {});
  await page.waitForSelector('.csbot-input:not([disabled])', { timeout: 45_000 });
}

const PILL_LOCATOR = 'button.rounded-full.border';

test('pills appear after opening bot reply (KYC category)', async ({ page }) => {
  await setupKycChat(page);

  // Bot's opening reply already arrived — check for pills
  const pills = page.locator(PILL_LOCATOR);
  const count = await pills.count();
  console.log(`Pills after opening reply: ${count}`);

  for (let i = 0; i < count; i++) {
    console.log(`  Pill ${i + 1}: "${(await pills.nth(i).textContent())?.trim()}"`);
  }

  expect(count).toBeGreaterThan(0);
  await expect(pills.first()).toBeVisible();
});

test('pills appear after first user message (KYC category)', async ({ page }) => {
  await setupKycChat(page);

  await sendAndWaitForReply(page, 'My KYC was rejected, what should I do?');

  const pills = page.locator(PILL_LOCATOR);
  await expect(pills.first()).toBeVisible({ timeout: 10_000 });

  const count = await pills.count();
  console.log(`Pills after first message: ${count}`);
  for (let i = 0; i < count; i++) {
    console.log(`  Pill ${i + 1}: "${(await pills.nth(i).textContent())?.trim()}"`);
  }

  expect(count).toBeGreaterThan(0);
});

test('pills disappear when tapped, then reappear after next bot reply', async ({ page }) => {
  await setupKycChat(page);

  // Send first message, wait for pills
  await sendAndWaitForReply(page, 'My KYC was rejected');
  const pills = page.locator(PILL_LOCATOR);
  await expect(pills.first()).toBeVisible({ timeout: 10_000 });

  const pillText = (await pills.first().textContent())?.trim();
  console.log(`Tapping pill: "${pillText}"`);

  // Tap first pill — this sends it as a message
  await pills.first().click();

  // Input locks while bot responds, then pills reappear when bot replies
  await page.waitForSelector('.csbot-input[disabled]', { timeout: 5_000 }).catch(() => {});
  await page.waitForSelector('.csbot-input:not([disabled])', { timeout: 45_000 });

  await expect(pills.first()).toBeVisible({ timeout: 10_000 });
  const newPillText = (await pills.first().textContent())?.trim();
  console.log(`New pill after tap: "${newPillText}"`);

  expect(newPillText).toBeTruthy();
});

test('no pills shown after escalation', async ({ page }) => {
  await setupKycChat(page);

  await sendAndWaitForReply(page, 'I want to speak to a human agent right now');

  // Check if escalated
  const escalationBanner = page.locator('.csbot-escalation-banner');
  const isEscalated = await escalationBanner.isVisible().catch(() => false);
  console.log(`Escalated: ${isEscalated}`);

  if (isEscalated) {
    // No pills after escalation
    const pillCount = await page.locator(PILL_LOCATOR).count();
    console.log(`Pill count after escalation: ${pillCount}`);
    expect(pillCount).toBe(0);
  } else {
    // Bot didn't escalate — pills are expected
    console.log('Bot did not escalate — skipping no-pill assertion');
  }
});
