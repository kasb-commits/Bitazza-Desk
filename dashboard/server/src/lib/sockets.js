// Socket.io server — all real-time events
const jwt = require('jsonwebtoken');
const { setAgentSession, deleteAgentSession, getAgentSession } = require('./redis');
const pool = require('../db/pg');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// Grace period before marking agent Offline on disconnect (FR-02 edge)
const DISCONNECT_GRACE_MS = 30_000;

let io; // set by init()

function init(httpServer) {
  const { Server } = require('socket.io');
  // When FRONTEND_URL is set (multi-service deployment), restrict to those origins.
  // When unset (same-origin deployment like Vercel), reflect the request origin
  // so Socket.io doesn't block itself — JWT auth in the handshake is the real gate.
  const corsOrigin = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map(s => s.trim())
    : true;

  io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
    // Short ping interval keeps WebSocket alive through Vercel's edge layer.
    // Also controls how often long-polling clients check for new events —
    // 2 s interval + 3 s timeout means polling latency ≤ 2 s.
    pingInterval: 2_000,
    pingTimeout: 3_000,
  });

  // Auth handshake — validate JWT before connection
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Missing token'));
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const { id: agentId, role } = socket.user;
    console.log(`[WS] connected: ${agentId} (${role})`);

    // Register socket in Redis (best-effort — non-fatal if Redis is down)
    try { await setAgentSession(agentId, { socket_id: socket.id }); } catch (e) {
      console.warn(`[WS] Redis unavailable, skipping session register for ${agentId}:`, e.message);
    }

    // Join personal room for targeted messages
    socket.join(`agent:${agentId}`);
    // Supervisors join supervisor room for capacity alerts
    if (role === 'supervisor' || role === 'super_admin') socket.join('supervisors');

    // ── C→S: agent:state_change (FR-01) ─────────────────────────────────────
    socket.on('agent:state_change', async ({ state }) => {
      const valid = ['Available', 'Busy', 'Break', 'Offline'];
      if (!valid.includes(state)) return;
      try { await setAgentSession(agentId, { state }); } catch {}
      // Broadcast presence to supervisors
      io.to('supervisors').emit('agent_presence', { agentId, state });
    });

    // ── C→S: typing (FR-07) ─────────────────────────────────────────────────
    socket.on('typing', ({ conversation_id }) => {
      if (!conversation_id) return;
      socket.to(`ticket:${conversation_id}`).emit('agent_typing', {
        conversation_id,
        agent_name: socket.user.name,
      });
    });

    // ── C→S: join_ticket ────────────────────────────────────────────────────
    socket.on('join_ticket', ({ ticket_id }) => {
      if (ticket_id) socket.join(`ticket:${ticket_id}`);
    });

    socket.on('leave_ticket', ({ ticket_id }) => {
      if (ticket_id) socket.leave(`ticket:${ticket_id}`);
    });

    // ── C→S: supervisor:whisper (FR-P3) ─────────────────────────────────────
    socket.on('supervisor:whisper', ({ ticket_id, agent_id, content }) => {
      if (!['supervisor', 'super_admin'].includes(role)) return;
      io.to(`agent:${agent_id}`).emit('whisper', {
        ticket_id,
        content,
        supervisor_name: socket.user.name,
      });
    });

    // ── C→S: supervisor:barge (FR-P3) ───────────────────────────────────────
    socket.on('supervisor:barge', ({ ticket_id }) => {
      if (!['supervisor', 'super_admin'].includes(role)) return;
      socket.join(`ticket:${ticket_id}`);
      io.to(`ticket:${ticket_id}`).emit('supervisor_joined', {
        ticket_id,
        supervisor_name: socket.user.name,
      });
    });

    // ── Disconnect with 30s grace ────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[WS] disconnected: ${agentId}`);
      setTimeout(async () => {
        // Check if agent reconnected (different socket)
        const session = await getAgentSession(agentId);
        if (session?.socket_id && session.socket_id !== socket.id) return; // reconnected
        // Grace expired — force Offline
        try { await setAgentSession(agentId, { state: 'Offline', socket_id: '' }); } catch {}
        io.to('supervisors').emit('agent_presence', { agentId, state: 'Offline' });

        // Notify supervisors if agent had open tickets assigned
        try {
          const { rows: openTickets } = await pool.query(
            `SELECT id FROM tickets WHERE assigned_to = $1
             AND status NOT IN ('Closed_Resolved','Closed_Unresponsive','Orphaned')`,
            [agentId]
          );
          if (openTickets.length > 0) {
            const { rows: supervisors } = await pool.query(
              `SELECT id FROM users WHERE role IN ('supervisor','admin','super_admin') AND active = TRUE`
            );
            const agentName = socket.user.name || agentId;
            const title = `Agent offline — ${agentName}`;
            const body = `${openTickets.length} open ticket${openTickets.length > 1 ? 's' : ''} left unattended`;
            for (const sup of supervisors) {
              const id = uuidv4();
              const { rows } = await pool.query(
                `INSERT INTO notifications (id, user_id, role, type, priority, title, body)
                 VALUES ($1,$2,'supervisor','agent_offline','high',$3,$4)
                 RETURNING id, user_id, role, type, priority, title, body, ticket_id, read, created_at`,
                [id, sup.id, title, body]
              );
              emitToAgent(sup.id, 'notification:new', { notification: rows[0] });
            }
          }
        } catch (err) {
          console.error('[sockets] agent_offline notification error:', err.message);
        }

        // TODO: re-queue orphaned chats (Phase 2)
      }, DISCONNECT_GRACE_MS);
    });
  });

  return io;
}

// Emit helpers called from route handlers
function emitToTicket(ticketId, event, payload) {
  if (!io) return;
  io.to(`ticket:${ticketId}`).emit(event, { conversation_id: ticketId, ...payload });
}

function emitToAgent(agentId, event, payload) {
  if (!io) return;
  io.to(`agent:${agentId}`).emit(event, payload);
}

function emitToSupervisors(event, payload) {
  if (!io) return;
  io.to('supervisors').emit(event, payload);
}

function emitToAll(event, payload) {
  if (!io) return;
  io.emit(event, payload);
}

module.exports = { init, emitToTicket, emitToAgent, emitToSupervisors, emitToAll };
