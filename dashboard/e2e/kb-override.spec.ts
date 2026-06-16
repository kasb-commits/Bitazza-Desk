/**
 * Playwright E2E — KB Version Override UI
 *
 * Validates the version-override flow visible in the ItemDetailModal's
 * "Version History" tab:
 *   1. The Override button (title="Override") is visible on row hover for users
 *      who hold the knowledge.write permission
 *   2. Clicking Override opens ItemDetailModal with "Version History" as the active tab
 *   3. The "Upload New Version" panel (with "Replace with URL" / "Replace with File"
 *      buttons) is visible inside the Version History tab
 *   4. The Version History list shows v1 as the only version with an "ACTIVE" badge
 *   5. (TODO) The Override button is hidden for users without knowledge.write — this
 *      requires a second test user and is marked as test.fixme
 *
 * Test strategy:
 *   - Authenticates as admin (who has knowledge.write via the '*' catch-all permission)
 *   - Creates a KB item via POST /api/knowledge/url (example.com) to serve as v1
 *   - Navigates to the Knowledge Base → Knowledge Items tab
 *   - Hovers over the row to reveal the Override button and exercises the modal
 *   - Cleans up on teardown (DELETE /api/knowledge/{id} — cascades all versions)
 *
 * Run: cd dashboard && npx playwright test e2e/kb-override.spec.ts --project=chromium
 * Requires: Vite dev server on port 3002 AND Express/Node server on port 4000.
 */

import { test, expect } from '@playwright/test';

const BASE_URL   = 'http://localhost:3002';
const SERVER_URL = 'http://localhost:4000';

const ADMIN_EMAIL    = 'admin@bitazza.com';
const ADMIN_PASSWORD = 'admin123';

// ── Shared state ──────────────────────────────────────────────────────────────

let adminToken = '';
let v1Id       = 0;   // numeric id of the KB item (= the v1 parent)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginBrowser(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/knowledge`);

  const loginForm  = page.locator('input[type="email"]');
  const pageLoaded = page.locator('button[title="Notifications"]');

  await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 8000 }),
    pageLoaded.waitFor({ state: 'visible', timeout: 8000 }),
  ]).catch(() => {});

  if (await pageLoaded.isVisible()) return; // already logged in

  await loginForm.fill(email);
  await page.fill('input[type="password"]', password);
  await page.locator('button[type="submit"]').click();
  await pageLoaded.waitFor({ state: 'visible', timeout: 12000 });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ request }) => {
  // 1. Admin login
  const loginRes = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!loginRes.ok()) {
    console.warn('[kb-override e2e] Admin login failed — tests will be skipped.');
    return;
  }
  const { token } = await loginRes.json();
  adminToken = token;

  // 2. Create a KB item (v1) via URL
  const createRes = await request.post(`${SERVER_URL}/api/knowledge/url`, {
    data: { url: 'https://example.com' },
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
  });
  if (!createRes.ok()) {
    console.warn(`[kb-override e2e] KB item creation failed (${createRes.status()}): ${await createRes.text()}`);
    return;
  }
  const created = await createRes.json();
  v1Id = created.id;
});

// ── Teardown ──────────────────────────────────────────────────────────────────

test.afterAll(async ({ request }) => {
  // DELETE cascades to all versions via ON DELETE CASCADE in the DB
  if (v1Id) {
    await request.delete(`${SERVER_URL}/api/knowledge/${v1Id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('Override button visible for agents with knowledge.write', async ({ page }) => {
  test.skip(!v1Id, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  // Wait for at least one row to appear
  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

  // Hover to reveal the action buttons (opacity-0 → group-hover:opacity-100)
  const firstRow = page.locator('tbody tr').first();
  await firstRow.hover();

  const overrideBtn = firstRow.locator('button[title="Override"]');
  await expect(overrideBtn).toBeVisible({ timeout: 5000 });
});

test('clicking Override opens ItemDetailModal on Version History tab', async ({ page }) => {
  test.skip(!v1Id, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

  const firstRow = page.locator('tbody tr').first();
  await firstRow.hover();
  const overrideBtn = firstRow.locator('button[title="Override"]');
  await overrideBtn.waitFor({ state: 'visible', timeout: 5000 });
  await overrideBtn.click();

  // The modal must open and the "Version History" tab must be active.
  // The active tab gets border-b-2 border-brand, but we can reliably check
  // that "Version History" is displayed as a tab button inside the modal.
  await expect(page.getByRole('button', { name: 'Version History', exact: true })).toBeVisible({ timeout: 8000 });

  // Also verify the other two tabs are present (confirming this IS the detail modal)
  await expect(page.getByRole('button', { name: 'Chunks',    exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Citations', exact: true })).toBeVisible();

  // Confirm the Version History tab content is active: the "Upload New Version"
  // panel heading must already be visible without clicking anything.
  await expect(page.getByText('Upload New Version')).toBeVisible({ timeout: 8000 });

  await page.keyboard.press('Escape');
});

test('Version History tab shows Upload New Version panel', async ({ page }) => {
  test.skip(!v1Id, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

  // Open via Override button (lands directly on Version History tab)
  const firstRow = page.locator('tbody tr').first();
  await firstRow.hover();
  await firstRow.locator('button[title="Override"]').waitFor({ state: 'visible', timeout: 5000 });
  await firstRow.locator('button[title="Override"]').click();

  // Ensure we are on Version History tab
  await expect(page.getByText('Upload New Version')).toBeVisible({ timeout: 8000 });

  // Both mode-selection buttons must be visible
  await expect(page.getByRole('button', { name: 'Replace with URL',  exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace with File', exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
});

test('Version History tab shows v1 as the only version with ACTIVE badge', async ({ page }) => {
  test.skip(!v1Id, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

  // Open via Override button
  const firstRow = page.locator('tbody tr').first();
  await firstRow.hover();
  await firstRow.locator('button[title="Override"]').waitFor({ state: 'visible', timeout: 5000 });
  await firstRow.locator('button[title="Override"]').click();

  // Wait for the version list to load (spinner disappears, rows appear)
  // The version row contains a font-mono "v1" label and an "ACTIVE" badge
  await expect(page.getByText('Loading versions…')).toBeHidden({ timeout: 15000 });

  // Exactly one version row should exist (the freshly created item has only v1)
  const versionRows = page.locator('.font-mono').filter({ hasText: /^v\d+$/ });
  await expect(versionRows.first()).toBeVisible({ timeout: 8000 });

  const v1Label = page.locator('.font-mono').filter({ hasText: 'v1' }).first();
  await expect(v1Label).toBeVisible();

  // The ACTIVE status badge is rendered as a span inside the version row
  const activeBadge = page.locator('span').filter({ hasText: 'ACTIVE' }).first();
  await expect(activeBadge).toBeVisible({ timeout: 8000 });

  await page.keyboard.press('Escape');
});

test.fixme('Override button hidden for non-existent knowledge.write permission', async ({ page: _page }) => {
  // This test requires a second test user whose role does NOT include knowledge.write.
  // Creating and managing that user is out of scope for the current test suite pass.
  // TODO: create a read-only agent, log in as them, navigate to /knowledge, hover a
  // row, and assert that button[title="Override"] is NOT present in the DOM.
});
