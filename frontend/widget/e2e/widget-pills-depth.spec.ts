/**
 * Production validation: how many consecutive turns show pills.
 */
import { test } from '@playwright/test';

const PROD_URL = 'https://widget-orpin-two.vercel.app';
const PILL = 'button.rounded-full.border';

async function setupKycChat(page: any) {
  await page.goto(PROD_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('[aria-label="Open support chat"], .csbot-launcher', { timeout: 10_000 });
  await page.click('[aria-label="Open support chat"], .csbot-launcher');
  await page.waitForSelector('.csbot-window', { timeout: 5_000 });
  await page.click('button:has-text("🇬🇧 English")');
  await page.waitForSelector('[data-testid="category-picker"]', { timeout: 5_000 });
  await page.click('button:has-text("KYC")');
  await page.waitForSelector('.csbot-input:not([disabled])', { timeout: 30_000 });
}

async function sendAndWaitForReply(page: any, text: string) {
  await page.fill('.csbot-input', text);
  await page.click('.csbot-send-btn');
  await page.waitForSelector('.csbot-input[disabled]', { timeout: 5_000 }).catch(() => {});
  await page.waitForSelector('.csbot-input:not([disabled])', { timeout: 45_000 });
}

test('pills depth — how many consecutive turns show pills', async ({ page }) => {
  await setupKycChat(page);

  // Turn 0: opening reply
  const t0 = await page.locator(PILL).count();
  console.log(`Turn 0 (opening): ${t0} pills`);

  const messages = [
    'My KYC was rejected, what should I do?',
    'What documents do I need to resubmit?',
    'How long does resubmission take?',
    'Will I be notified when it is approved?',
    'What happens if it gets rejected again?',
  ];

  for (let i = 0; i < messages.length; i++) {
    const escalated = await page.locator('.csbot-escalation-banner').isVisible().catch(() => false);
    if (escalated) {
      console.log(`Turn ${i + 1}: ESCALATED — stopping`);
      break;
    }

    await sendAndWaitForReply(page, messages[i]);

    const count = await page.locator(PILL).count();
    const pills: string[] = [];
    for (let j = 0; j < count; j++) {
      pills.push((await page.locator(PILL).nth(j).textContent())?.trim() ?? '');
    }
    console.log(`Turn ${i + 1}: ${count} pills — [${pills.map(p => `"${p}"`).join(', ')}]`);
  }
});
