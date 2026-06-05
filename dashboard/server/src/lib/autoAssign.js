'use strict';

/**
 * Core logic for auto-assigning escalated tickets.
 * Kept express-free so it can be unit-tested directly.
 */

const pool   = require('../db/pg');
const { routeTicket, getAssignmentRules } = require('../routes/tickets');
const sockets = require('./sockets');
const { v4: uuidv4 } = require('uuid');

async function resolveTeam(category) {
  try {
    const rules = await getAssignmentRules();
    const map =
      typeof rules['category_team_map'] === 'string'
        ? JSON.parse(rules['category_team_map'])
        : (rules['category_team_map'] ?? {});
    return map[category] ?? 'cs';
  } catch {
    return 'cs';
  }
}

function checkAuth(secret) {
  const expected = process.env.INTERNAL_SECRET || 'internal-dev-token';
  return secret === expected;
}

async function handleAutoAssign(ticketId, { category, priority = 3, customer_id }) {
  if (!customer_id) return { status: 400, body: { error: 'customer_id required' } };

  const team = await resolveTeam(category);

  const { rows: tRows } = await pool.query(
    'SELECT assigned_to, status FROM tickets WHERE id = $1',
    [ticketId],
  );
  if (!tRows.length) return { status: 404, body: { error: 'Ticket not found' } };
  // Race-condition guard: if already re-assigned and actively being handled, skip.
  // But if the ticket is in an escalated state (pending_human / Escalated), always
  // proceed — the existing assigned_to is the pre-escalation agent, not a specialist.
  const ESCALATED_STATUSES = ['pending_human', 'Escalated'];
  if (tRows[0].assigned_to && !ESCALATED_STATUSES.includes(tRows[0].status)) {
    return { status: 200, body: { assigned: true, agent_id: tRows[0].assigned_to, queued: false } };
  }

  const assignedTo = await routeTicket(ticketId, customer_id, Number(priority), team);

  if (assignedTo) {
    const { rows: ticketInfo } = await pool.query(
      `SELECT c.name AS customer_name, t.channel
       FROM tickets t JOIN customers c ON t.customer_id = c.id
       WHERE t.id = $1`,
      [ticketId],
    );
    const notifId = uuidv4();
    const { rows: notifRows } = await pool.query(
      `INSERT INTO notifications (id, user_id, role, type, priority, title, body, ticket_id)
       VALUES ($1, $2, 'agent', 'escalation_assigned', 'high', $3, $4, $5) RETURNING *`,
      [
        notifId,
        assignedTo,
        'Escalated ticket assigned to you',
        `From ${ticketInfo[0]?.customer_name ?? 'a customer'} — ${ticketInfo[0]?.channel ?? 'web'} channel`,
        ticketId,
      ],
    );
    sockets.emitToAgent(assignedTo, 'notification:new', { notification: notifRows[0] });
    return { status: 200, body: { assigned: true, agent_id: assignedTo, queued: false } };
  }

  // No available agent — notify supervisors
  const { rows: supervisors } = await pool.query(
    `SELECT id FROM users WHERE role IN ('supervisor', 'admin', 'super_admin') AND active = true`,
  );
  for (const sup of supervisors) {
    const notifId = uuidv4();
    const { rows: supNotif } = await pool.query(
      `INSERT INTO notifications (id, user_id, role, type, priority, title, body, ticket_id)
       VALUES ($1, $2, 'supervisor', 'escalation_unassigned', 'high', $3, $4, $5) RETURNING *`,
      [
        notifId,
        sup.id,
        'Escalated ticket needs manual assignment',
        `No available ${team} agents — ticket #${ticketId.slice(0, 8)}`,
        ticketId,
      ],
    );
    sockets.emitToAgent(sup.id, 'notification:new', { notification: supNotif[0] });
  }
  return { status: 200, body: { assigned: false, queued: true } };
}

module.exports = { checkAuth, handleAutoAssign };
