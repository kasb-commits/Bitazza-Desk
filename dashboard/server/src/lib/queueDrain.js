'use strict';

const pool = require('../db/pg');
const { routeTicket, getAssignmentRules } = require('../routes/tickets');

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

/**
 * Called when one agent goes Available — drain at most one ticket for their team.
 */
async function drainQueueForAgent(agentId, team) {
  const { rows } = await pool.query(
    `SELECT id, customer_id, priority, category FROM tickets
     WHERE status IN ('Escalated', 'pending_human') AND assigned_to IS NULL AND team = $1
     ORDER BY priority ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [team ?? 'cs'],
  );
  if (!rows.length) return;
  const t = rows[0];
  await routeTicket(t.id, t.customer_id, t.priority, team ?? 'cs');
}

/**
 * Called by 60s cron — drain all unassigned Escalated tickets.
 */
async function drainAllQueues() {
  const { rows } = await pool.query(
    `SELECT id, customer_id, priority, category, team FROM tickets
     WHERE status IN ('Escalated', 'pending_human') AND assigned_to IS NULL
     ORDER BY priority ASC, created_at ASC`,
  );
  if (!rows.length) return;
  console.log(`[queue-drain] processing ${rows.length} unassigned escalated tickets`);
  for (const t of rows) {
    const team = t.team ?? (await resolveTeam(t.category));
    try {
      await routeTicket(t.id, t.customer_id, t.priority, team);
    } catch (err) {
      console.error(`[queue-drain] failed ${t.id}:`, err.message);
    }
  }
}

module.exports = { drainQueueForAgent, drainAllQueues };
