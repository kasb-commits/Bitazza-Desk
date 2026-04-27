/**
 * Playwright test: NotificationPanel "Select" button
 *
 * Reproduces the bug where clicking "Select" caused the panel to close/reset
 * due to a useEffect that exited select mode immediately on entry.
 *
 * Root cause: useEffect({ if (selectMode && selected.size === 0) setSelectMode(false) })
 * fired on initial entry when selected was still empty.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:3002';

// Reusable: log in and wait for the TopBar to appear
async function login(page: import('@playwright/test').Page) {
  await page.goto(BASE_URL);

  // Wait up to 5s for either the login form or the TopBar (already logged in)
  const loginForm = page.locator('input[type="email"]');
  const topBar = page.locator('button[title="Notifications"]');

  await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 5000 }),
    topBar.waitFor({ state: 'visible', timeout: 5000 }),
  ]).catch(() => {});

  // If the bell is already visible, we're logged in
  if (await topBar.isVisible()) return;

  // Otherwise fill the login form
  await loginForm.fill('admin@bitazza.com');
  await page.fill('input[type="password"]', 'admin123');
  await page.locator('button[type="submit"]').click();

  // Wait for TopBar to appear (login success)
  await topBar.waitFor({ state: 'visible', timeout: 10000 });
}

// Reusable: open the notification panel via the bell button
async function openNotificationPanel(page: import('@playwright/test').Page) {
  const bell = page.locator('button[title="Notifications"]');
  await bell.waitFor({ state: 'visible', timeout: 5000 });
  await bell.click();
  // Panel is present when the "Notifications" heading is visible
  await expect(page.getByText('Notifications').first()).toBeVisible({ timeout: 3000 });
}

test.describe('NotificationPanel — Select mode', () => {

  test('clicking Select enters select mode and shows toolbar', async ({ page }) => {
    await login(page);
    await openNotificationPanel(page);

    // Locate the "Select" button in the panel header
    const selectBtn = page.locator('button', { hasText: /^Select$/ });
    await expect(selectBtn).toBeVisible({ timeout: 3000 });

    // --- capture state before click ---
    const panelBeforeClick = await page.locator('text=Select all').isVisible().catch(() => false);
    console.log('[test] select toolbar visible before click:', panelBeforeClick);

    // Click Select
    await selectBtn.click();

    // After clicking, the selection toolbar should appear
    // It contains "Select all" text (the toolbar label)
    const toolbar = page.locator('text=Select all');
    const toolbarVisible = await toolbar.isVisible().catch(() => false);
    console.log('[test] select toolbar visible after click:', toolbarVisible);

    // The panel should still be open (Notifications heading still present)
    await expect(page.getByText('Notifications').first()).toBeVisible({
      timeout: 1000,
    });

    // The select toolbar must now be visible
    await expect(toolbar).toBeVisible({ timeout: 2000 });

    // The "Select" button should no longer be in the header (replaced by Cancel)
    const cancelBtn = page.locator('button', { hasText: /^Cancel$/ });
    await expect(cancelBtn).toBeVisible({ timeout: 2000 });
  });

  test('Cancel button exits select mode', async ({ page }) => {
    await login(page);
    await openNotificationPanel(page);

    // Enter select mode
    await page.locator('button', { hasText: /^Select$/ }).click();
    await expect(page.locator('text=Select all')).toBeVisible({ timeout: 2000 });

    // Click Cancel
    await page.locator('button', { hasText: /^Cancel$/ }).click();

    // Toolbar should be gone
    await expect(page.locator('text=Select all')).not.toBeVisible({ timeout: 2000 });

    // Panel still open
    await expect(page.getByText('Notifications').first()).toBeVisible({ timeout: 1000 });
  });

  test('clicking outside panel closes it but not clicking inside', async ({ page }) => {
    await login(page);
    await openNotificationPanel(page);

    // Click somewhere inside the panel (e.g. the Notifications heading)
    await page.getByText('Notifications').first().click();

    // Panel must still be open
    await expect(page.getByText('Notifications').first()).toBeVisible({ timeout: 1000 });

    // Now click outside (top-left corner, well away from panel)
    await page.mouse.click(50, 300);

    // Panel should close
    await expect(page.locator('button', { hasText: /^Select$/ })).not.toBeVisible({
      timeout: 2000,
    });
  });

});
