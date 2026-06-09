'use strict';

/**
 * Unit tests for routeTicket — specifically the u.active = true filter and the
 * Redis Available-state check that governs auto-assignment eligibility.
 *
 * Root cause being tested: routeTicket previously queried users without filtering
 * u.active = true, allowing deactivated accounts into the candidate pool (though
 * they'd be skipped by the Redis state check). More critically, if Redis had no
 * state entry for an agent, session?.state === undefined and they were silently
 * excluded even when live and available.
 *
 * Run: cd dashboard/server && npx jest tests/route-ticket-active.test.js --verbose
 */

jest.mock('../src/db/pg',              () => ({ query: jest.fn() }));
jest.mock('../src/lib/redis',          () => ({
  getAgentSession:    jest.fn(),
  setAgentSession:    jest.fn(),
  claimTicketLock:    jest.fn(),
  releaseTicketLock:  jest.fn(),
  pushQueueBack:      jest.fn().mockResolvedValue(undefined),
  pushQueueFront:     jest.fn().mockResolvedValue(undefined),
  getQueueDepth:      jest.fn().mockResolvedValue(0),
  popQueue:           jest.fn(),
  keys:               { agentSession: jest.fn() },
}));
jest.mock('../src/lib/sockets', () => ({
  emitToAgent:       jest.fn(),
  emitToSupervisors: jest.fn(),
  emitToTicket:      jest.fn(),
  init:              jest.fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate:       (req, res, next) => next(),
  requireRole:        () => (req, res, next) => next(),
  requirePermission:  () => (req, res, next) => next(),
  signToken:          jest.fn(),
  getPermissionsForRole: jest.fn().mockReturnValue([]),
}));

const pool   = require('../src/db/pg');
const redis  = require('../src/lib/redis');
const sockets = require('../src/lib/sockets');

// Clear module cache so the mocks are in place when tickets.js is required
let routeTicket;
beforeAll(() => {
  ({ routeTicket } = require('../src/routes/tickets'));
});

const TICKET_ID   = 'ticket-1111-2222-3333-4444';
const CUSTOMER_ID = 'customer-aaaa-bbbb-cccc-dddd';
const AGENT_ID    = 'agent-uuid-0001';
const AGENT_NAME  = 'Somchai Test';

beforeEach(() => jest.clearAllMocks());

// ── Helper: mock the full DB call sequence for a successful assignment ─────────
function mockSuccessfulAssignment() {
  // Call order inside routeTicket (with cache busted):
  // 1. getAssignmentRules — SELECT key, value FROM assignment_rules
  // 2. Sticky agent query
  // 3. Available agents query (DB candidates)
  // [getAgentSession → Redis, not pool]
  // [getAssignmentRules again → uses in-process cache, NO pool hit]
  // 4. UPDATE tickets SET assigned_to / status / sla_deadline
  // 5. SELECT name, avatar_url FROM users (for insertSystemMsg + socket payload)
  // 6. INSERT INTO messages (system message)
  pool.query
    .mockResolvedValueOnce({ rows: [{ key: 'sticky_agent_hours', value: '12' }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: AGENT_ID, max_chats: 5, active_chats: '1', last_assigned_at: null }] })
    .mockResolvedValueOnce({ rows: [] })   // UPDATE tickets
    .mockResolvedValueOnce({ rows: [{ name: AGENT_NAME, avatar_url: null }] })
    .mockResolvedValueOnce({ rows: [{ id: 'msg-1', content: `Auto-assigned to ${AGENT_NAME}`, created_at: new Date().toISOString() }] });
}

// ── SQL query contains u.active = true ────────────────────────────────────────

test('available-agents SQL includes u.active = true filter and super_admin role', async () => {
  pool.query
    .mockResolvedValue({ rows: [] });  // no-op — just observe the query
  redis.getAgentSession.mockResolvedValue({ state: 'Available' });

  await routeTicket(TICKET_ID, CUSTOMER_ID, 3, 'cs');

  // Find the call that queries the users table for available agents
  const agentQuery = pool.query.mock.calls.find(
    ([sql]) => typeof sql === 'string' && sql.includes('FROM users u') && sql.includes('max_chats'),
  );
  expect(agentQuery).toBeDefined();
  expect(agentQuery[0]).toMatch(/u\.active\s*=\s*true/i);
  expect(agentQuery[0]).toMatch(/super_admin/i);
});

// ── Active agent with Available Redis state → gets assigned ───────────────────

test('assigns ticket to active Available agent and returns their ID', async () => {
  mockSuccessfulAssignment();
  redis.getAgentSession.mockResolvedValue({ state: 'Available' });
  // bust the assignment rules cache between tests
  const { bustRulesCache } = require('../src/routes/tickets');
  bustRulesCache();

  const assigned = await routeTicket(TICKET_ID, CUSTOMER_ID, 3, 'cs');

  expect(assigned).toBe(AGENT_ID);
  // Verify system message was inserted with agent name
  const insertCall = pool.query.mock.calls.find(
    ([sql]) => typeof sql === 'string' && sql.toUpperCase().startsWith('INSERT INTO MESSAGES'),
  );
  expect(insertCall).toBeDefined();
  // Verify socket event was emitted to the agent
  expect(sockets.emitToAgent).toHaveBeenCalledWith(
    AGENT_ID,
    'ticket:assigned',
    expect.objectContaining({ ticketId: TICKET_ID, agentId: AGENT_ID, agentName: AGENT_NAME }),
  );
});

// ── Agent with no Redis state → NOT assigned ──────────────────────────────────

test('does NOT assign to agent whose Redis session has no state', async () => {
  const { bustRulesCache } = require('../src/routes/tickets');
  bustRulesCache();

  pool.query
    .mockResolvedValueOnce({ rows: [] })       // assignment_rules
    .mockResolvedValueOnce({ rows: [] })       // sticky
    .mockResolvedValueOnce({ rows: [{ id: AGENT_ID, max_chats: 5, active_chats: '0', last_assigned_at: null }] })
    // No more queries — agent filtered out; falls through to queue
    .mockResolvedValue({ rows: [] });
  // Empty Redis session — no state field
  redis.getAgentSession.mockResolvedValue({});

  const assigned = await routeTicket(TICKET_ID, CUSTOMER_ID, 3, 'cs');

  expect(assigned).toBeNull();
  expect(sockets.emitToAgent).not.toHaveBeenCalledWith(AGENT_ID, 'ticket:assigned', expect.anything());
  expect(sockets.emitToSupervisors).toHaveBeenCalledWith('capacity:zero_alert', expect.any(Object));
});

// ── Agent with Offline Redis state → NOT assigned ─────────────────────────────

test('does NOT assign to agent whose Redis state is Offline', async () => {
  const { bustRulesCache } = require('../src/routes/tickets');
  bustRulesCache();

  pool.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: AGENT_ID, max_chats: 5, active_chats: '0', last_assigned_at: null }] })
    .mockResolvedValue({ rows: [] });
  redis.getAgentSession.mockResolvedValue({ state: 'Offline' });

  const assigned = await routeTicket(TICKET_ID, CUSTOMER_ID, 3, 'cs');

  expect(assigned).toBeNull();
});

// ── No available agents → ticket queued, supervisors notified ─────────────────

test('returns null and queues ticket when no Available agents found', async () => {
  const { bustRulesCache } = require('../src/routes/tickets');
  bustRulesCache();

  pool.query
    .mockResolvedValueOnce({ rows: [] })   // assignment_rules
    .mockResolvedValueOnce({ rows: [] })   // sticky
    .mockResolvedValueOnce({ rows: [] })   // no agents at all
    .mockResolvedValue({ rows: [] });

  const assigned = await routeTicket(TICKET_ID, CUSTOMER_ID, 3, 'cs');

  expect(assigned).toBeNull();
  expect(redis.pushQueueBack).toHaveBeenCalledWith('cs', TICKET_ID);
  expect(sockets.emitToSupervisors).toHaveBeenCalledWith('capacity:zero_alert', expect.any(Object));
});

// ── VIP (priority 1) queued at front ──────────────────────────────────────────

test('pushes priority-1 ticket to front of queue when no agents available', async () => {
  const { bustRulesCache } = require('../src/routes/tickets');
  bustRulesCache();

  pool.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValue({ rows: [] });

  await routeTicket(TICKET_ID, CUSTOMER_ID, 1, 'cs');

  expect(redis.pushQueueFront).toHaveBeenCalledWith('cs', TICKET_ID);
  expect(redis.pushQueueBack).not.toHaveBeenCalled();
});
