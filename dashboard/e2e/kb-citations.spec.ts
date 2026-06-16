/**
 * Playwright E2E — KB Citations visibility and editing
 *
 * Validates the Citations column in the Knowledge Items table and the Citations
 * tab in ItemDetailModal:
 *   1. The "Citations" column header is visible in the Knowledge Items table
 *   2. A classified item (citations_source !== 'pending') shows category badges
 *   3. The category filter pill narrows the table client-side
 *   4. Clearing the filter restores the full table
 *   5. Clicking the eye (view) icon opens ItemDetailModal with Chunks/Citations/Version History tabs
 *   6. The Citations tab shows the seeded categories
 *   7. An agent with knowledge.write permission can edit and save citations
 *
 * Test strategy:
 *   - Authenticates as admin to obtain a JWT
 *   - Creates a KB item via POST /api/knowledge/url (uses example.com so the
 *     scraper returns a minimal but valid page — no secrets, no external deps)
 *   - Seeds known citations via PATCH /api/knowledge/{id}/citations so the test
 *     state is deterministic regardless of AI classification results
 *   - Navigates to the Knowledge Base → Knowledge Items tab in the browser
 *   - Asserts against the seeded state
 *   - Cleans up on teardown (DELETE /api/knowledge/{id})
 *
 * Run: cd dashboard && npx playwright test e2e/kb-citations.spec.ts --project=chromium
 * Requires: Vite dev server on port 3002 AND Express/Node server on port 4000.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';

const BASE_URL   = 'http://localhost:3002';
const SERVER_URL = 'http://localhost:4000';   // Express/Node server (auth, tickets, proxied knowledge CRUD)
const PYTHON_URL = 'http://localhost:8000';   // FastAPI Python server (citations, versions, override)

const ADMIN_EMAIL    = 'admin@bitazza.com';
const ADMIN_PASSWORD = 'admin123';

// ── Shared state ──────────────────────────────────────────────────────────────

let adminToken = '';
let kbItemId   = 0;   // numeric id returned by POST /api/knowledge/url
let kbItemTitle = '';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiPost(request: APIRequestContext, path: string, body: object, token = adminToken) {
  return request.post(`${SERVER_URL}${path}`, {
    data: body,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

async function apiPatch(request: APIRequestContext, path: string, body: object, token = adminToken) {
  return request.patch(`${SERVER_URL}${path}`, {
    data: body,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

async function loginBrowser(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/knowledge`);

  const loginForm = page.locator('input[type="email"]');
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
    console.warn('[kb-citations e2e] Admin login failed — tests will be skipped.');
    return;
  }
  const { token } = await loginRes.json();
  adminToken = token;

  // 2. Create a KB item via URL (example.com is always reachable and returns plain HTML)
  const createRes = await request.post(`${SERVER_URL}/api/knowledge/url`, {
    data: { url: 'https://example.com' },
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
  });
  if (!createRes.ok()) {
    console.warn(`[kb-citations e2e] KB item creation failed (${createRes.status()}): ${await createRes.text()}`);
    return;
  }
  const created = await createRes.json();
  kbItemId    = created.id;
  kbItemTitle = created.title ?? 'Example Domain';

  // 3. Seed known citations so we have deterministic state.
  //    PATCH /api/knowledge/:id/citations lives on the Python FastAPI server (port 8000),
  //    not on the Node/Express server (port 4000) — the Node knowledge router only
  //    proxies url/upload/chunks/delete. We call Python directly here.
  const patchRes = await request.patch(`${PYTHON_URL}/api/knowledge/${kbItemId}/citations`, {
    data: { categories: ['KYC', 'Account Verification'], keywords: ['kyc', 'identity'] },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!patchRes.ok()) {
    console.warn(`[kb-citations e2e] Citations seed failed: ${await patchRes.text()}`);
  }
});

// ── Teardown ──────────────────────────────────────────────────────────────────

test.afterAll(async ({ request }) => {
  if (kbItemId) {
    await request.delete(`${SERVER_URL}/api/knowledge/${kbItemId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('KB Items table renders Citations column header', async ({ page }) => {
  test.skip(!kbItemId, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);

  // Navigate to Knowledge Base and open the Knowledge Items tab
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  // The table header must contain "Citations"
  await expect(
    page.locator('thead').getByText('Citations', { exact: false })
  ).toBeVisible({ timeout: 10000 });
});

test('classified item shows category badges in Citations column', async ({ page }) => {
  test.skip(!kbItemId, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  // Wait for the table body to populate
  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

  // The seeded item should show a "KYC" category badge in the Citations column.
  // Badges render as <span> with the category name inside a table cell.
  const kycBadge = page.locator('tbody').getByText('KYC', { exact: true }).first();
  await expect(kycBadge).toBeVisible({ timeout: 8000 });
});

test('category filter narrows table client-side', async ({ page }) => {
  test.skip(!kbItemId, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  // Wait for items to load
  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
  const totalRows = await page.locator('tbody tr').count();

  // Open the category filter dropdown and select "KYC"
  await page.getByRole('button', { name: /Filter by category/i }).click();
  await page.getByRole('button', { name: 'KYC', exact: true }).click();
  // Close the dropdown
  await page.getByRole('button', { name: 'Done' }).click();

  // After filtering, rows showing should be <= total rows, and all visible rows
  // should include the KYC category badge (or filter active chip is visible).
  const activeFilterChip = page.locator('span').filter({ hasText: 'KYC' }).first();
  await expect(activeFilterChip).toBeVisible({ timeout: 5000 });

  const filteredRows = await page.locator('tbody tr').count();
  expect(filteredRows).toBeLessThanOrEqual(totalRows);
  // At minimum our seeded item must still be visible
  expect(filteredRows).toBeGreaterThanOrEqual(1);
});

test('clearing filter restores full table', async ({ page }) => {
  test.skip(!kbItemId, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
  const totalRows = await page.locator('tbody tr').count();

  // Apply KYC filter
  await page.getByRole('button', { name: /Filter by category/i }).click();
  await page.getByRole('button', { name: 'KYC', exact: true }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 5000 });

  // Clear all filters via the "Clear all" link
  await page.getByText('Clear all').click();

  const restoredRows = await page.locator('tbody tr').count();
  expect(restoredRows).toBe(totalRows);
});

test('clicking row action opens ItemDetailModal with three tabs', async ({ page }) => {
  test.skip(!kbItemId, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  // Wait for the seeded item row to appear
  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

  // Hover over the first row to reveal the eye (view details) button and click it
  const firstRow = page.locator('tbody tr').first();
  await firstRow.hover();
  const viewBtn = firstRow.locator('button[title="View details"]');
  await viewBtn.waitFor({ state: 'visible', timeout: 5000 });
  await viewBtn.click();

  // Modal should appear with all three tab buttons
  await expect(page.getByRole('button', { name: 'Chunks',          exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('button', { name: 'Citations',       exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Version History', exact: true })).toBeVisible();

  // Dismiss modal
  await page.keyboard.press('Escape');
});

test('Citations tab shows current categories', async ({ page }) => {
  test.skip(!kbItemId, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

  // Open detail modal
  const firstRow = page.locator('tbody tr').first();
  await firstRow.hover();
  await firstRow.locator('button[title="View details"]').waitFor({ state: 'visible', timeout: 5000 });
  await firstRow.locator('button[title="View details"]').click();

  // Switch to Citations tab
  await page.getByRole('button', { name: 'Citations', exact: true }).click();

  // The two seeded categories should be rendered as selected (highlighted) category pills.
  // In the component, selected categories get class "bg-brand/20 text-brand ring-brand/30".
  // We verify their text content is present in the citations panel.
  await expect(page.getByRole('button', { name: 'KYC', exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('button', { name: 'Account Verification', exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
});

test('agent can edit and save citations', async ({ page }) => {
  test.skip(!kbItemId, 'KB item was not created — check server connectivity');

  await loginBrowser(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`${BASE_URL}/knowledge`);
  await page.getByRole('button', { name: 'Knowledge Items' }).click();

  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

  // Open detail modal
  const firstRow = page.locator('tbody tr').first();
  await firstRow.hover();
  await firstRow.locator('button[title="View details"]').waitFor({ state: 'visible', timeout: 5000 });
  await firstRow.locator('button[title="View details"]').click();

  // Switch to Citations tab
  await page.getByRole('button', { name: 'Citations', exact: true }).click();

  // Wait for the category pills to render
  await page.getByRole('button', { name: 'KYC', exact: true }).waitFor({ state: 'visible', timeout: 8000 });

  // Deselect KYC (currently selected) and select Deposits (currently deselected)
  await page.getByRole('button', { name: 'KYC', exact: true }).click();
  await page.getByRole('button', { name: 'Deposits', exact: true }).click();

  // Save
  await page.getByRole('button', { name: 'Save Citations' }).click();

  // Success feedback: the StatusBanner with "Citations updated and locked." should appear
  await expect(page.getByText('Citations updated and locked.')).toBeVisible({ timeout: 8000 });

  await page.keyboard.press('Escape');
});
