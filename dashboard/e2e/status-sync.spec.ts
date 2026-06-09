/**
 * Playwright test: PropertiesPanel status change syncs to MessageThread header
 *
 * Reproduces the bug where changing a ticket's status from the right-side
 * PropertiesPanel didn't update the StatusDropdown in the MessageThread header.
 *
 * Root cause: MessageThread maintained independent ticket state; PropertiesPanel's
 * onUpdate only refreshed App.tsx tickets[], not MessageThread.ticket.
 *
 * Fix: App.tsx increments listVersion after each loadTickets(); MessageThread
 * watches listVersion and calls load() when it changes.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:3002';

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE_URL}/inbox`);

  const loginForm = page.locator('input[type="email"]');
  const topBar    = page.locator('button[title="Notifications"]');

  await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 5000 }),
    topBar.waitFor({ state: 'visible', timeout: 5000 }),
  ]).catch(() => {});

  if (await topBar.isVisible()) return;

  await loginForm.fill('admin@bitazza.com');
  await page.fill('input[type="password"]', 'admin123');
  await page.locator('button[type="submit"]').click();
  await topBar.waitFor({ state: 'visible', timeout: 10000 });
}

test.describe('Status sync: PropertiesPanel → MessageThread header', () => {

  test('changing status in right panel updates the header status badge', async ({ page }) => {
    await login(page);

    // ── 1. Open first ticket ──────────────────────────────────────────────────
    const firstRow = page.locator('.cursor-pointer').first();
    await firstRow.waitFor({ state: 'visible', timeout: 8000 });
    await firstRow.click();

    // Wait for MessageThread and PropertiesPanel to render
    const rightPanel = page.locator('aside').last(); // PropertiesPanel (left nav is aside.first())
    await rightPanel.waitFor({ state: 'visible', timeout: 8000 });

    // ── 2. Read current status from MessageThread header ──────────────────────
    // The StatusDropdown button is a colored pill in the header right section.
    // It renders the status text with underscores replaced by spaces.
    const STATUSES = ['Open Live', 'In Progress', 'Pending Customer', 'Escalated', 'Closed Resolved', 'Closed Unresponsive', 'Orphaned'];

    // Find the header status button (the pill with colored background, not the Select in aside)
    // It's outside the <aside> element
    const headerStatusBtn = page.locator('button').filter({
      hasText: new RegExp(`^(${STATUSES.join('|')})$`),
    }).first();

    await headerStatusBtn.waitFor({ state: 'visible', timeout: 8000 });
    const currentStatus = (await headerStatusBtn.textContent())?.trim() ?? '';
    console.log('[test] current header status:', currentStatus);

    // ── 3. Pick a different status to switch to ───────────────────────────────
    const TARGET_STATUS = STATUSES.find(s => s !== currentStatus && s !== 'Closed Resolved' && s !== 'Closed Unresponsive') ?? 'In Progress';
    console.log('[test] will change to:', TARGET_STATUS);

    // ── 4. Open the PropertiesPanel Status Select ─────────────────────────────
    // The Select trigger button inside <aside> shows the current status as its text.
    const propsPanelSelectBtn = rightPanel.locator('button', { hasText: currentStatus }).first();

    await propsPanelSelectBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[test] PropertiesPanel Select button text:', await propsPanelSelectBtn.innerText());
    await propsPanelSelectBtn.click();

    // ── 5. Click the target status option in the portal dropdown ──────────────
    const dropdownOption = page.locator('.ds-dropdown button').filter({ hasText: TARGET_STATUS });
    await dropdownOption.waitFor({ state: 'visible', timeout: 3000 });
    await dropdownOption.click();

    console.log('[test] clicked target status in dropdown');

    // ── 6. Assert MessageThread header reflects the new status ────────────────
    // After the fix, listVersion increments → MessageThread calls load() → header updates.
    // Allow up to 6s for: API call + loadTickets() + listVersion increment + load() + re-render.
    await expect(headerStatusBtn).toHaveText(TARGET_STATUS, { timeout: 6000 });
    console.log('[test] PASS — header status updated to:', TARGET_STATUS);
  });

});
