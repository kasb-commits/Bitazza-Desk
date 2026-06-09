/**
 * Tests for dashboard/server/src/routes/notifications.js
 *
 * Covers:
 *   - SLA breach: emitToAgent called per-supervisor with full DB row; emitToSupervisors NOT called
 *   - SLA breach: assigned-agent notification emitted with full row
 *   - SLA breach: missing ticket_id returns 400 without DB calls
 *   - Bulk mark: empty ids array returns 400
 *   - Bulk mark: non-boolean read returns 400
 *   - Bulk mark: valid payload updates and returns count
 *   - Mark read / unread: ownership enforced (user_id = req.user.id)
 *
 * Run: cd dashboard/server && npx jest tests/notifications.test.js --verbose
 */
'use strict';

// Pin JWT_SECRET before any module is loaded — auth.js reads it at require-time
// via dotenv.config(). dotenv never overrides an already-set env var, so this wins.
process.env.JWT_SECRET = 'test-notifications-jwt-secret';

jest.mock('../src/db/pg',       () => ({ query: jest.fn() }));
jest.mock('../src/lib/sockets', () => ({
  emitToAgent:       jest.fn(),
  emitToSupervisors: jest.fn(),
  emitToTicket:      jest.fn(),
  emitToAll:         jest.fn(),
}));

const express                            = require('express');
const request                            = require('supertest');
const jwt                                = require('jsonwebtoken');
const pool                               = require('../src/db/pg');
const { emitToAgent, emitToSupervisors } = require('../src/lib/sockets');

// authenticate reads JWT_SECRET from env (falls back to 'change-me-in-production').
// We sign tokens with the same secret so the middleware passes.
const TEST_SECRET = 'test-notifications-jwt-secret';
function makeToken(userId = 'user-agent-1') {
  return jwt.sign({ id: userId, role: 'agent', permissions: [] }, TEST_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', require('../src/routes/notifications'));
  return app;
}

// Attach a valid Authorization header to every supertest request
function authed(req, userId = 'user-agent-1') {
  return req.set('Authorization', `Bearer ${makeToken(userId)}`);
}

// ── SLA Breach ────────────────────────────────────────────────────────────────

describe('POST /api/notifications/sla-breach', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test('emits full DB row per supervisor via emitToAgent — emitToSupervisors never called', async () => {
    const agentRow = {
      id: 'notif-a', user_id: 'assigned-agent', role: 'agent',
      type: 'sla_breach', priority: 'critical',
      title: 'SLA Breached — Ticket #ticket-1',
      body: 'Alice (Standard) — response time exceeded',
      ticket_id: 'ticket-1-uuid', read: false, created_at: '2026-06-09T10:00:00Z',
    };
    const sup1Row = {
      id: 'notif-s1', user_id: 'sup-1', role: 'supervisor',
      type: 'sla_breach', priority: 'critical',
      title: 'SLA Breached — Ticket #ticket-1',
      body: 'Alice (Standard) — response time exceeded',
      ticket_id: 'ticket-1-uuid', read: false, created_at: '2026-06-09T10:00:00Z',
    };
    const sup2Row = {
      id: 'notif-s2', user_id: 'sup-2', role: 'supervisor',
      type: 'sla_breach', priority: 'critical',
      title: 'SLA Breached — Ticket #ticket-1',
      body: 'Alice (Standard) — response time exceeded',
      ticket_id: 'ticket-1-uuid', read: false, created_at: '2026-06-09T10:00:00Z',
    };

    pool.query
      .mockResolvedValueOnce({ rows: [agentRow] })                          // INSERT for assigned agent
      .mockResolvedValueOnce({ rows: [{ id: 'sup-1' }, { id: 'sup-2' }] }) // SELECT supervisors
      .mockResolvedValueOnce({ rows: [sup1Row] })                           // INSERT for sup-1
      .mockResolvedValueOnce({ rows: [sup2Row] });                          // INSERT for sup-2

    const res = await authed(request(app)
      .post('/api/notifications/sla-breach'))
      .send({ ticket_id: 'ticket-1-uuid', customer_name: 'Alice', assigned_to: 'assigned-agent', priority: 3 });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(3);

    // The old buggy broadcast must never fire
    expect(emitToSupervisors).not.toHaveBeenCalled();

    // One emit per recipient — assigned agent + 2 supervisors = 3 total
    expect(emitToAgent).toHaveBeenCalledTimes(3);

    // Each emit carries the full persisted row (with id, user_id, read, created_at)
    expect(emitToAgent).toHaveBeenCalledWith('assigned-agent', 'notification:new', { notification: agentRow });
    expect(emitToAgent).toHaveBeenCalledWith('sup-1',          'notification:new', { notification: sup1Row  });
    expect(emitToAgent).toHaveBeenCalledWith('sup-2',          'notification:new', { notification: sup2Row  });
  });

  test('supervisor notification payload has all required identity fields', async () => {
    const supRow = {
      id: 'notif-s1', user_id: 'sup-1', role: 'supervisor',
      type: 'sla_breach', priority: 'critical',
      title: 'SLA Breached — Ticket #ticket-2',
      body: 'Bob (VIP) — response time exceeded',
      ticket_id: 'ticket-2-uuid', read: false, created_at: '2026-06-09T10:00:00Z',
    };

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'sup-1' }] }) // SELECT supervisors (no assigned_to)
      .mockResolvedValueOnce({ rows: [supRow] });          // INSERT for sup-1

    const res = await authed(request(app)
      .post('/api/notifications/sla-breach'))
      .send({ ticket_id: 'ticket-2-uuid', customer_name: 'Bob', priority: 1 }); // no assigned_to

    expect(res.status).toBe(200);
    expect(emitToAgent).toHaveBeenCalledTimes(1);

    const [, , payload] = emitToAgent.mock.calls[0];
    const n = payload.notification;

    // These fields being present is the core of the bug fix — the old partial
    // payload was missing id, user_id, read, created_at, causing dedup to fail
    expect(n.id).toBe('notif-s1');
    expect(n.user_id).toBe('sup-1');
    expect(n.read).toBe(false);
    expect(n.created_at).toBeDefined();
    expect(n.type).toBe('sla_breach');
    expect(n.priority).toBe('critical');
  });

  test('VIP priority label renders correctly in body', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'sup-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'notif-s1', user_id: 'sup-1', role: 'supervisor', type: 'sla_breach', priority: 'critical', title: 'SLA Breached — Ticket #abc123', body: 'Unknown customer (VIP) — response time exceeded', ticket_id: 'abc123', read: false, created_at: new Date().toISOString() }] });

    const res = await authed(request(app)
      .post('/api/notifications/sla-breach'))
      .send({ ticket_id: 'abc123ef-uuid', priority: 1 }); // priority 1 = VIP

    expect(res.status).toBe(200);
    const [, , payload] = emitToAgent.mock.calls[0];
    expect(payload.notification.body).toContain('VIP');
  });

  test('returns 400 and makes no DB calls when ticket_id is missing', async () => {
    const res = await authed(request(app)
      .post('/api/notifications/sla-breach'))
      .send({ customer_name: 'Alice', assigned_to: 'agent-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ticket_id/);
    expect(pool.query).not.toHaveBeenCalled();
    expect(emitToAgent).not.toHaveBeenCalled();
    expect(emitToSupervisors).not.toHaveBeenCalled();
  });

  test('skips assigned-agent INSERT when assigned_to is absent', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })  // SELECT supervisors — empty result
    ;

    const res = await authed(request(app)
      .post('/api/notifications/sla-breach'))
      .send({ ticket_id: 'ticket-3-uuid' }); // no assigned_to, no supervisors

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    // Only one query (SELECT supervisors) — no INSERT for agent
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(emitToAgent).not.toHaveBeenCalled();
  });
});

// ── Bulk mark ─────────────────────────────────────────────────────────────────

describe('PATCH /api/notifications/bulk', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test('returns 400 when ids is an empty array', async () => {
    const res = await authed(request(app)
      .patch('/api/notifications/bulk'))
      .send({ ids: [], read: true });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns 400 when ids is not an array', async () => {
    const res = await authed(request(app)
      .patch('/api/notifications/bulk'))
      .send({ ids: 'id-1', read: true });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns 400 when read is a string instead of boolean', async () => {
    const res = await authed(request(app)
      .patch('/api/notifications/bulk'))
      .send({ ids: ['id-1'], read: 'true' });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('updates and returns count for valid payload', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 2 });

    const res = await authed(request(app)
      .patch('/api/notifications/bulk'))
      .send({ ids: ['id-1', 'id-2'], read: false });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    // Ownership must be enforced: user_id = req.user.id
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('user_id');
    expect(params).toContain('user-agent-1');
  });
});

// ── Mark read / unread (single) ───────────────────────────────────────────────

describe('PATCH /api/notifications/:id/read and /unread', () => {
  let app;
  const OWNER = 'owner-user';

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test('mark-read enforces ownership via user_id in UPDATE', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await authed(request(app)
      .patch('/api/notifications/notif-abc/read'), OWNER);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('read');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('user_id');
    expect(params).toContain(OWNER);
    expect(params).toContain('notif-abc');
  });

  test('mark-read returns 404 when notification belongs to another user', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 }); // no row updated — wrong owner

    const res = await authed(request(app)
      .patch('/api/notifications/notif-abc/read'), OWNER);

    expect(res.status).toBe(404);
  });

  test('mark-unread enforces ownership via user_id in UPDATE', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await authed(request(app)
      .patch('/api/notifications/notif-abc/unread'), OWNER);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unread');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('user_id');
    expect(params).toContain(OWNER);
  });
});

// ── GET /api/notifications ────────────────────────────────────────────────────

describe('GET /api/notifications', () => {
  let app;
  const UID = 'user-42';

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test('returns only notifications for the authenticated user', async () => {
    const rows = [
      { id: 'n1', user_id: UID, role: 'agent', type: 'sla_breach', priority: 'high', title: 'T', body: 'B', ticket_id: null, read: false, created_at: new Date().toISOString() },
    ];
    pool.query.mockResolvedValueOnce({ rows });

    const res = await authed(request(app).get('/api/notifications'), UID);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    // Query must filter by the authenticated user — never return all notifications
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('user_id');
    expect(params).toContain(UID);
  });
});
