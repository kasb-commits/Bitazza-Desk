// Redis client (singleton)
const { createClient } = require('redis');
require('dotenv').config();

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (attempts) => {
      if (attempts >= 3) return false; // stop retrying after 3 attempts
      return Math.min(attempts * 200, 1000);
    },
  },
});

client.on('error', () => {}); // suppress repeated error logs — boot handles it
client.on('connect', () => console.log('[Redis] connected'));

// Connect with a 2s timeout so boot doesn't hang when Redis is unavailable
let connecting = null;
async function ensureConnected() {
  if (client.isReady) return;
  if (!connecting) {
    // Normalize "Socket already opened" — thrown when connect() is called after
    // a previous attempt already opened the socket (e.g. after reconnect gave up).
    // Treat it the same as any other connection failure so callers don't crash.
    const connectPromise = client.connect().catch(err => {
      if (err.message && err.message.includes('already opened')) {
        throw new Error('Redis unavailable');
      }
      throw err;
    });
    connecting = Promise.race([
      connectPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connect timeout')), 2000)),
    ]).catch(err => { connecting = null; throw err; });
  }
  await connecting;
}

// ── Key helpers ──────────────────────────────────────────────────────────────

const keys = {
  agentSession: (id) => `agent:session:${id}`,      // Hash { state, active_chats, socket_id }
  agentDisconnect: (id) => `agent:disconnect:${id}`, // String, 30s TTL
  ticketLock: (id) => `ticket:lock:${id}`,           // String, 5s TTL (SETNX claim)
  ticketQueuePos: (id) => `ticket:queue_pos:${id}`,  // String, 1h TTL
  queueLive: (team) => `queue:live:${team}`,         // List (LPUSH=front, RPUSH=back)
  queueEmail: (team) => `queue:email:${team}`,       // List
  botFlowActive: () => 'bot:flow:active',            // String (published flow JSON)
  geminiRate: (agentId) => `rate:gemini:${agentId}`, // Counter, 60s TTL
};

// ── Agent session helpers ────────────────────────────────────────────────────

async function getAgentSession(agentId) {
  await ensureConnected();
  return client.hGetAll(keys.agentSession(agentId));
}

async function setAgentSession(agentId, fields) {
  await ensureConnected();
  await client.hSet(keys.agentSession(agentId), fields);
  await client.expire(keys.agentSession(agentId), 86400); // 24h TTL
}

async function deleteAgentSession(agentId) {
  await ensureConnected();
  await client.del(keys.agentSession(agentId));
}

// ── Ticket lock (atomic claim, FR-03) ────────────────────────────────────────

async function claimTicketLock(ticketId) {
  await ensureConnected();
  // SETNX with 5s TTL — returns true if we won the lock
  const result = await client.set(keys.ticketLock(ticketId), '1', { NX: true, EX: 5 });
  return result === 'OK';
}

async function releaseTicketLock(ticketId) {
  await ensureConnected();
  await client.del(keys.ticketLock(ticketId));
}

// ── Queue helpers ─────────────────────────────────────────────────────────────

async function pushQueueBack(team, ticketId) {
  await ensureConnected();
  await client.rPush(keys.queueLive(team), ticketId);
}

async function pushQueueFront(team, ticketId) {
  await ensureConnected();
  await client.lPush(keys.queueLive(team), ticketId);
}

async function popQueue(team) {
  await ensureConnected();
  return client.lPop(keys.queueLive(team));
}

async function getQueueDepth(team) {
  await ensureConnected();
  return client.lLen(keys.queueLive(team));
}

module.exports = {
  client,
  ensureConnected,
  keys,
  getAgentSession,
  setAgentSession,
  deleteAgentSession,
  claimTicketLock,
  releaseTicketLock,
  pushQueueBack,
  pushQueueFront,
  popQueue,
  getQueueDepth,
};
