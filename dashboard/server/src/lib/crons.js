// Background cron jobs — started once from index.js
// FR-06: sla_checker (30s)
// FR-12: nudge_sender (15min)
// FR-13: auto_closer  (15min)
const pool = require('../db/pg');
const { emitToTicket, emitToSupervisors } = require('./sockets');

function start() {
  // ── SLA checker (FR-06) — every 30s ────────────────────────────────────────
  setInterval(async () => {
    try {
      const { rows } = await pool.query(`
        UPDATE tickets SET sla_breached=true
        WHERE sla_deadline < NOW()
          AND sla_breached = false
          AND status NOT IN ('Closed_Resolved','Closed_Unresponsive')
        RETURNING id, priority, customer_id
      `);
      for (const t of rows) {
        emitToTicket(t.id, 'sla:breach', { ticketId: t.id, priority: t.priority });
        emitToSupervisors('sla:breach', { ticketId: t.id });
      }
      if (rows.length) console.log(`[cron/sla] ${rows.length} tickets breached`);
    } catch (err) {
      console.error('[cron/sla] error:', err.message);
    }
  }, 30_000);

  // ── Nudge sender (FR-12) — every 15min ────────────────────────────────────
  setInterval(async () => {
    try {
      const { rows } = await pool.query(`
        SELECT t.id, t.channel, c.email, c.line_uid, c.fb_psid
        FROM tickets t
        JOIN customers c ON t.customer_id = c.id
        WHERE t.status = 'Pending_Customer'
          AND t.last_customer_msg_at < NOW() - INTERVAL '24 hours'
          AND t.nudge_sent_at IS NULL
      `);
      for (const t of rows) {
        const msg = "Hi, we noticed you may still need help. Reply if unresolved, or we'll close in 24 hours.";
        await pool.query(
          `INSERT INTO messages (ticket_id, sender_type, content) VALUES ($1,'system',$2)`,
          [t.id, msg]
        );
        await pool.query(
          `UPDATE tickets SET nudge_sent_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [t.id]
        );
        emitToTicket(t.id, 'new_message', {
          message: { role: 'system', sender_type: 'system', content: msg, created_at: Math.floor(Date.now()/1000) },
        });
      }
      if (rows.length) console.log(`[cron/nudge] sent ${rows.length} nudges`);
    } catch (err) {
      console.error('[cron/nudge] error:', err.message);
    }
  }, 15 * 60_000);

  // ── Auto-closer (FR-13) — every 15min ─────────────────────────────────────
  setInterval(async () => {
    try {
      const { rows } = await pool.query(`
        UPDATE tickets SET status='Closed_Unresponsive', updated_at=NOW()
        WHERE status = 'Pending_Customer'
          AND last_customer_msg_at < NOW() - INTERVAL '48 hours'
        RETURNING id
      `);
      for (const t of rows) {
        const closeMsg = "Ticket closed due to no response. Contact us again if needed.";
        await pool.query(
          `INSERT INTO messages (ticket_id, sender_type, content) VALUES ($1,'system',$2)`,
          [t.id, closeMsg]
        );
        // Fire CSAT prompt (send as system message with metadata)
        await pool.query(
          `INSERT INTO messages (ticket_id, sender_type, content, metadata)
           VALUES ($1,'system','Please rate your support experience.','{"csat":true}')`,
          [t.id]
        );
        emitToTicket(t.id, 'ticket:updated', { ticketId: t.id, changes: { status: 'Closed_Unresponsive' } });
      }
      if (rows.length) console.log(`[cron/auto-close] closed ${rows.length} tickets`);
    } catch (err) {
      console.error('[cron/auto-close] error:', err.message);
    }
  }, 15 * 60_000);

  // ── Python API keepalive — every 5min ────────────────────────────────────
  // Prevents Railway from sleeping the Python service, which causes 10-20s
  // cold-start delays on the first ticket poll after a period of inactivity.
  const PYTHON_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';
  setInterval(async () => {
    try {
      await fetch(`${PYTHON_URL}/health`, { signal: AbortSignal.timeout(5000) });
    } catch { /* non-fatal — just a keepalive ping */ }
  }, 5 * 60_000);

  console.log('[crons] started (sla:30s, nudge:15m, auto-close:15m, keepalive:5m)');
}

module.exports = { start };
