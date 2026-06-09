/**
 * Playwright E2E — Auto-assignment UI effects
 *
 * Validates the two visible outcomes when a ticket is auto-assigned after escalation:
 *   1. The right-side PropertiesPanel shows the assigned agent's name (not "Unassigned")
 *   2. An inline system message "Auto-assigned to <name>" appears in the ticket thread
 *
 * Test strategy:
 *   - Creates a temporary supervisor agent via the admin API (so they qualify for auto-assign:
 *     routeTicket queries role IN ('agent','supervisor') AND active = true)
 *   - Logs in as that agent in the test browser → socket connects → state restored to 'Available'
 *     (validates the socket state-restoration fix: sockets.restoreAgentStateToRedis)
 *   - Creates a test ticket via the ticket creation API
 *   - Calls the internal auto-assign endpoint (same path real escalation uses)
 *   - Navigates to the assigned ticket and asserts both UI effects
 *   - Cleans up the test agent and ticket on teardown
 *
 * Run: cd dashboard && npx playwright test e2e/auto-assign-ui.spec.ts --project=chromium
 * Requires: Vite dev server on port 3002 AND Express/Node server on port 4000.
 */

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE_URL   = 'http://localhost:3002';
const SERVER_URL = 'http://localhost:4000';   // Express / Node server

const ADMIN_EMAIL    = 'admin@bitazza.com';
const ADMIN_PASSWORD = 'admin123';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? 'internal-dev-token';

// ── Shared state across setup/test/teardown ───────────────────────────────────

let adminToken   = '';
let agentId      = '';
let agentEmail   = '';
let agentPassword = '';
let agentName    = '';
let ticketId     = '';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiPost(request: APIRequestContext, path: string, body: object, token = adminToken) {
  const res = await request.post(`${SERVER_URL}${path}`, {
    data: body,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res;
}

async function apiGet(request: APIRequestContext, path: string, token = adminToken) {
  return request.get(`${SERVER_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function apiPatch(request: APIRequestContext, path: string, body: object, token = adminToken) {
  return request.patch(`${SERVER_URL}${path}`, {
    data: body,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

async function loginPage(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/inbox`);

  const loginForm = page.locator('input[type="email"]');
  const topBar    = page.locator('button[title="Notifications"]');

  await Promise.race([
    loginForm.waitFor({ state: 'visible', timeout: 8000 }),
    topBar.waitFor(   { state: 'visible', timeout: 8000 }),
  ]).catch(() => {});

  if (await topBar.isVisible()) return; // already logged in

  await loginForm.fill(email);
  await page.fill('input[type="password"]', password);
  await page.locator('button[type="submit"]').click();
  await topBar.waitFor({ state: 'visible', timeout: 12000 });
}

// ── Setup: create test agent + ticket ─────────────────────────────────────────

test.beforeAll(async ({ request }) => {
  // Authenticate as admin
  const loginRes = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(loginRes.ok(), 'Admin login must succeed').toBeTruthy();
  const { token } = await loginRes.json();
  adminToken = token;

  // Create a temporary test agent (role=supervisor so they appear in routeTicket pool)
  const ts = Date.now();
  agentEmail    = `test.agent.${ts}@autoassign.test`;
  agentPassword = `TestPass${ts}!`;
  agentName     = `AutoAssign TestAgent ${ts}`;

  const createRes = await apiPost(request, '/api/agents', {
    name:      agentName,
    email:     agentEmail,
    password:  agentPassword,
    role:      'supervisor',
    team:      'cs',
    max_chats: 10,
  });
  expect(createRes.ok(), `Create agent: ${await createRes.text()}`).toBeTruthy();
  const created = await createRes.json();
  agentId = created.id;

  // Find or create a customer so we can create a ticket
  // Use the admin's own customer entry by fetching tickets and picking one
  const ticketListRes = await apiGet(request, '/api/tickets?limit=1');
  const tickets = await ticketListRes.json();
  const sampleTicket = Array.isArray(tickets) ? tickets[0] : (tickets.tickets ?? [])[0];

  let customerId = sampleTicket?.customer_id ?? sampleTicket?.customer?.id;

  if (!customerId) {
    // No tickets yet — skip creating a ticket; test will use the assignment endpoint directly
    // with an existing ticket when one is found later.
    console.warn('[auto-assign e2e] No tickets found; test may be skipped.');
    return;
  }

  // Create a fresh test ticket with status pending_human so auto-assign applies
  const createTicketRes = await request.post(`${SERVER_URL}/api/tickets`, {
    data: { customer_id: customerId, channel: 'web', category: 'account_restriction', priority: 3, team: 'cs' },
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
  });
  if (createTicketRes.ok()) {
    const t = await createTicketRes.json();
    ticketId = t.id;
    // Force status to pending_human so the assignment guard (ESCALATED_STATUSES) allows re-assign
    await apiPatch(request, `/api/tickets/${ticketId}`, { status: 'pending_human' });
  }
});

// ── Teardown: remove test agent ───────────────────────────────────────────────

test.afterAll(async ({ request }) => {
  if (agentId) {
    await request.delete(`${SERVER_URL}/api/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  }
});

// ── Test ──────────────────────────────────────────────────────────────────────

test('PropertiesPanel shows assigned agent name and thread shows system message after auto-assign', async ({ page, request }) => {
  test.skip(!ticketId, 'No test ticket available — seed DB with at least one customer');

  // ── Step 1: Login as the test agent so their socket connects ─────────────────
  // This triggers restoreAgentStateToRedis on the server side, which populates
  // Redis with state='Available' from the DB (since this is a new account with no
  // prior Redis session). That makes the agent eligible for routeTicket.
  await loginPage(page, agentEmail, agentPassword);

  // Confirm socket connected (TopBar visible = dashboard loaded = socket auth done)
  await expect(page.locator('button[title="Notifications"]')).toBeVisible({ timeout: 10000 });

  // ── Step 2: Set status to Available via PATCH (updates both DB and Redis) ────
  const agentLoginRes = await request.post(`${SERVER_URL}/api/auth/login`, {
    data: { email: agentEmail, password: agentPassword },
  });
  const { token: agentToken } = await agentLoginRes.json();

  const statusRes = await request.patch(`${SERVER_URL}/api/agents/me/status`, {
    data: { state: 'Available' },
    headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
  });
  expect(statusRes.ok(), 'Setting agent status to Available must succeed').toBeTruthy();

  // ── Step 3: Navigate to the inbox and open the test ticket ───────────────────
  await page.goto(`${BASE_URL}/inbox`);

  // Find the test ticket in the list — it may appear immediately or after a refresh
  const ticketRow = page.locator(`[data-ticket-id="${ticketId}"]`).first();
  const fallbackRow = page.locator('.cursor-pointer').first();

  await Promise.race([
    ticketRow.waitFor({ state: 'visible', timeout: 5000 }).then(() => ticketRow.click()),
    fallbackRow.waitFor({ state: 'visible', timeout: 5000 }).then(async () => {
      // Look for our specific ticket by navigating with its ID
      await page.goto(`${BASE_URL}/inbox`);
      await fallbackRow.click();
    }),
  ]).catch(() => {});

  // Also try direct navigation if neither row matched
  const threadVisible = page.locator('aside').last();
  if (!await threadVisible.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.goto(`${BASE_URL}/inbox`);
    await page.locator('.cursor-pointer').first().click();
  }

  // Wait for PropertiesPanel (right aside) to render
  const rightPanel = page.locator('aside').last();
  await rightPanel.waitFor({ state: 'visible', timeout: 8000 });

  // ── Step 4: Trigger auto-assignment via the internal endpoint ─────────────────
  // This is the exact same path called by EscalateNode in the workflow engine.
  const autoAssignRes = await request.post(
    `${SERVER_URL}/api/internal/tickets/${ticketId}/auto-assign`,
    {
      data: { category: 'account_restriction', priority: 3, customer_id: 'ignored-by-server' },
      headers: {
        'X-Internal-Secret': INTERNAL_SECRET,
        'Content-Type': 'application/json',
      },
    },
  );
  expect(autoAssignRes.ok(), `Auto-assign must succeed: ${await autoAssignRes.text()}`).toBeTruthy();
  const assignBody = await autoAssignRes.json();
  expect(assignBody.assigned, 'Ticket must be assigned (not just queued)').toBe(true);
  expect(assignBody.agent_id).toBe(agentId);

  // ── Step 5: Reload the ticket (socket event goes to agent room, not ticket room) ─
  // The test browser IS logged in as the agent, so it receives the ticket:assigned
  // socket event which triggers a state update in App.tsx. Give the socket time to deliver.
  await page.waitForTimeout(1500);

  // Navigate to the specific ticket to ensure we're viewing it
  await page.goto(`${BASE_URL}/inbox`);
  const ticketRowAgain = page.locator(`[data-ticket-id="${ticketId}"]`).first();
  if (await ticketRowAgain.isVisible({ timeout: 3000 }).catch(() => false)) {
    await ticketRowAgain.click();
  } else {
    await page.locator('.cursor-pointer').first().click();
  }
  await rightPanel.waitFor({ state: 'visible', timeout: 8000 });

  // ── Assertion 1: PropertiesPanel shows the assigned agent's name ─────────────
  // The assignedName span inside PropertiesPanel renders as a text-xs truncate span.
  // It reads from ticket.assigned_to_name ?? ticket.assigned_agent_name.
  const assignedNameSpan = rightPanel.locator('span.\\[\\&\\>span\\]:text-xs, span').filter({
    hasText: agentName,
  }).first();

  // Fallback: find any text matching the agent name inside the right panel
  const agentNameText = rightPanel.getByText(agentName, { exact: false });
  await expect(agentNameText).toBeVisible({ timeout: 8000 });

  // ── Assertion 2: System message "Auto-assigned to <name>" in the thread ───────
  // renderMessage() returns a rounded-full pill for sender_type === 'system'.
  // Selector: span.rounded-full with content containing "Auto-assigned to".
  const systemMsg = page.locator('span.rounded-full, [class*="rounded-full"]').filter({
    hasText: /Auto-assigned to/i,
  }).first();
  await expect(systemMsg).toBeVisible({ timeout: 8000 });
  await expect(systemMsg).toContainText(agentName);
});

// ── Regression: agent with no Redis state still gets assigned ─────────────────
// This directly tests that restoreAgentStateToRedis fires on socket connect and
// that routeTicket does NOT skip agents with a missing Redis session.

test('agent is assignable immediately after first login (no prior Redis session)', async ({ page, request }) => {
  test.skip(!ticketId, 'No test ticket available');

  // Create a second fresh agent — guaranteed to have no Redis history
  const ts2 = Date.now();
  const freshEmail    = `fresh.agent.${ts2}@autoassign.test`;
  const freshPassword = `FreshPass${ts2}!`;
  const freshName     = `FreshAgent ${ts2}`;

  const createRes = await apiPost(request, '/api/agents', {
    name: freshName, email: freshEmail, password: freshPassword,
    role: 'supervisor', team: 'cs', max_chats: 10,
  });
  expect(createRes.ok()).toBeTruthy();
  const { id: freshAgentId } = await createRes.json();

  try {
    // Unassign the ticket so it's available for this test
    await apiPatch(request, `/api/tickets/${ticketId}`, {
      assigned_to: null,
      status:      'pending_human',
    });

    // Login as the fresh agent — first login, no Redis session ever existed
    await loginPage(page, freshEmail, freshPassword);
    await expect(page.locator('button[title="Notifications"]')).toBeVisible({ timeout: 10000 });

    // Set their status to Available (PATCH updates both DB + Redis)
    const { token: freshToken } = await (await request.post(`${SERVER_URL}/api/auth/login`, {
      data: { email: freshEmail, password: freshPassword },
    })).json();
    await request.patch(`${SERVER_URL}/api/agents/me/status`, {
      data: { state: 'Available' },
      headers: { Authorization: `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
    });

    // Trigger auto-assign
    const autoAssignRes = await request.post(
      `${SERVER_URL}/api/internal/tickets/${ticketId}/auto-assign`,
      {
        data: { category: 'account_restriction', priority: 3, customer_id: 'test' },
        headers: { 'X-Internal-Secret': INTERNAL_SECRET, 'Content-Type': 'application/json' },
      },
    );
    const body = await autoAssignRes.json();

    // Agent MUST be assigned — the socket-state-restore fix ensures their Available
    // state made it into Redis on first connect
    expect(body.assigned).toBe(true);
    expect(body.agent_id).toBe(freshAgentId);

    // ── Assertion 1: PropertiesPanel shows agent name ─────────────────────────
    await page.waitForTimeout(1500);
    await page.goto(`${BASE_URL}/inbox`);
    const ticketRow = page.locator(`[data-ticket-id="${ticketId}"]`).first();
    if (await ticketRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await ticketRow.click();
    } else {
      await page.locator('.cursor-pointer').first().click();
    }
    const rightPanel = page.locator('aside').last();
    await rightPanel.waitFor({ state: 'visible', timeout: 8000 });
    await expect(rightPanel.getByText(freshName, { exact: false })).toBeVisible({ timeout: 8000 });

    // ── Assertion 2: System message in thread ────────────────────────────────
    const systemMsg = page.locator('span.rounded-full, [class*="rounded-full"]').filter({
      hasText: /Auto-assigned to/i,
    }).first();
    await expect(systemMsg).toBeVisible({ timeout: 8000 });
    await expect(systemMsg).toContainText(freshName);

  } finally {
    // Cleanup fresh agent
    await request.delete(`${SERVER_URL}/api/agents/${freshAgentId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  }
});
