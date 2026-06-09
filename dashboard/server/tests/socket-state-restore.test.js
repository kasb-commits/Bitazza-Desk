'use strict';

/**
 * Unit tests for sockets.restoreAgentStateToRedis
 *
 * Root cause being tested: on socket connect, only socket_id was written to Redis.
 * If Redis had no `state` entry (Redis restart, 24h TTL expiry, first-ever login),
 * routeTicket would see session?.state === undefined and skip the agent → no assignment.
 *
 * Fix: on connect, if Redis has no `state`, restore it from users.state in PostgreSQL.
 *
 * Run: cd dashboard/server && npx jest tests/socket-state-restore.test.js --verbose
 */

jest.mock('../src/db/pg',      () => ({ query: jest.fn() }));
jest.mock('../src/lib/redis',  () => ({
  getAgentSession:   jest.fn(),
  setAgentSession:   jest.fn().mockResolvedValue(undefined),
  deleteAgentSession: jest.fn(),
}));
// sockets.js also requires socket.io at init() time — mock it so require doesn't throw
jest.mock('socket.io', () => {
  const Server = jest.fn().mockImplementation(() => ({
    use:  jest.fn(),
    on:   jest.fn(),
    to:   jest.fn().mockReturnThis(),
    emit: jest.fn(),
  }));
  return { Server };
});
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../src/lib/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const pool  = require('../src/db/pg');
const redis = require('../src/lib/redis');
const { restoreAgentStateToRedis } = require('../src/lib/sockets');

const AGENT_ID  = 'agent-uuid-1111';
const SOCKET_ID = 'socket-abc123';

beforeEach(() => jest.clearAllMocks());

// ── Core fix: state restored when Redis session is empty ──────────────────────

test('sets state from DB when Redis session has no state', async () => {
  redis.getAgentSession.mockResolvedValue({});  // empty session — no state key
  pool.query.mockResolvedValue({ rows: [{ state: 'Available' }] });

  await restoreAgentStateToRedis(AGENT_ID, SOCKET_ID);

  expect(pool.query).toHaveBeenCalledWith('SELECT state FROM users WHERE id=$1', [AGENT_ID]);
  expect(redis.setAgentSession).toHaveBeenCalledWith(AGENT_ID, {
    socket_id: SOCKET_ID,
    state:     'Available',
  });
});

test('sets state from DB when Redis session is completely missing (hGetAll returns null)', async () => {
  redis.getAgentSession.mockResolvedValue(null);
  pool.query.mockResolvedValue({ rows: [{ state: 'Busy' }] });

  await restoreAgentStateToRedis(AGENT_ID, SOCKET_ID);

  expect(redis.setAgentSession).toHaveBeenCalledWith(AGENT_ID, {
    socket_id: SOCKET_ID,
    state:     'Busy',
  });
});

test('defaults state to Available when DB column is NULL', async () => {
  redis.getAgentSession.mockResolvedValue({});
  pool.query.mockResolvedValue({ rows: [{ state: null }] });

  await restoreAgentStateToRedis(AGENT_ID, SOCKET_ID);

  expect(redis.setAgentSession).toHaveBeenCalledWith(AGENT_ID, {
    socket_id: SOCKET_ID,
    state:     'Available',
  });
});

test('defaults state to Available when agent not found in DB', async () => {
  redis.getAgentSession.mockResolvedValue({});
  pool.query.mockResolvedValue({ rows: [] });

  await restoreAgentStateToRedis(AGENT_ID, SOCKET_ID);

  expect(redis.setAgentSession).toHaveBeenCalledWith(AGENT_ID, {
    socket_id: SOCKET_ID,
    state:     'Available',
  });
});

// ── State already set in Redis: DB must NOT be queried ────────────────────────

test('does NOT query DB when Redis already has a state', async () => {
  redis.getAgentSession.mockResolvedValue({ state: 'Available', socket_id: 'old-socket' });

  await restoreAgentStateToRedis(AGENT_ID, SOCKET_ID);

  expect(pool.query).not.toHaveBeenCalled();
  expect(redis.setAgentSession).toHaveBeenCalledWith(AGENT_ID, { socket_id: SOCKET_ID });
});

test('preserves Offline state set by disconnect grace period (agent must re-enable manually)', async () => {
  // Grace period sets state: 'Offline' after 30s of disconnection.
  // On reconnect we must NOT auto-restore to Available — agent should click the toggle.
  redis.getAgentSession.mockResolvedValue({ state: 'Offline', socket_id: '' });

  await restoreAgentStateToRedis(AGENT_ID, SOCKET_ID);

  expect(pool.query).not.toHaveBeenCalled();
  // Only socket_id updated; state untouched
  expect(redis.setAgentSession).toHaveBeenCalledWith(AGENT_ID, { socket_id: SOCKET_ID });
  expect(redis.setAgentSession).not.toHaveBeenCalledWith(
    AGENT_ID,
    expect.objectContaining({ state: 'Available' }),
  );
});

test('preserves Busy/Break state when Redis already has it', async () => {
  redis.getAgentSession.mockResolvedValue({ state: 'Busy', socket_id: 'old-socket' });

  await restoreAgentStateToRedis(AGENT_ID, SOCKET_ID);

  expect(pool.query).not.toHaveBeenCalled();
  expect(redis.setAgentSession).toHaveBeenCalledWith(AGENT_ID, { socket_id: SOCKET_ID });
});

// ── Only socket_id is written when Redis already has state ────────────────────

test('does not include state field in setAgentSession when Redis already has it', async () => {
  redis.getAgentSession.mockResolvedValue({ state: 'Available', socket_id: 'prev' });

  await restoreAgentStateToRedis(AGENT_ID, SOCKET_ID);

  const calledWith = redis.setAgentSession.mock.calls[0][1];
  expect(Object.keys(calledWith)).toEqual(['socket_id']);
  expect(calledWith.socket_id).toBe(SOCKET_ID);
});
