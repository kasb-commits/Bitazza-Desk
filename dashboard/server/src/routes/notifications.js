// /api/notifications
const router = require('express').Router();
const pool   = require('../db/pg');
const { authenticate } = require('../middleware/auth');
const { emitToAgent, emitToSupervisors } = require('../lib/sockets');
const { v4: uuidv4 } = require('uuid');

// ── GET /api/notifications ────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, role, type, priority, title, body, ticket_id, read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[notifications] GET error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/notifications/:id/read ────────────────────────────────────────
router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ status: 'read' });
  } catch (err) {
    console.error('[notifications] PATCH read error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/notifications/:id/unread ──────────────────────────────────────
router.patch('/:id/unread', authenticate, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read = FALSE WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ status: 'unread' });
  } catch (err) {
    console.error('[notifications] PATCH unread error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/notifications/read-all/mark ───────────────────────────────────
router.patch('/read-all/mark', authenticate, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE`,
      [req.user.id]
    );
    res.json({ updated: rowCount });
  } catch (err) {
    console.error('[notifications] PATCH read-all error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/notifications/bulk ────────────────────────────────────────────
// Body: { ids: string[], read: boolean }
router.patch('/bulk', authenticate, async (req, res) => {
  const { ids, read } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
  if (typeof read !== 'boolean') return res.status(400).json({ error: 'read must be boolean' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read = $1 WHERE id = ANY($2::uuid[]) AND user_id = $3`,
      [read, ids, req.user.id]
    );
    res.json({ updated: rowCount });
  } catch (err) {
    console.error('[notifications] PATCH bulk error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/notifications/sla-breach ───────────────────────────────────────
router.post('/sla-breach', authenticate, async (req, res) => {
  const { ticket_id, customer_name, assigned_to, priority = 3 } = req.body;
  if (!ticket_id) return res.status(400).json({ error: 'ticket_id required' });

  const tierLabel = { 1: 'VIP', 2: 'EA', 3: 'Standard' }[priority] ?? 'Standard';
  const customerLabel = customer_name || 'Unknown customer';
  const title = `SLA Breached — Ticket #${ticket_id.slice(0, 8)}`;
  const body  = `${customerLabel} (${tierLabel}) — response time exceeded`;

  const created = [];
  try {
    // Notify assigned agent
    if (assigned_to) {
      const id = uuidv4();
      const { rows } = await pool.query(
        `INSERT INTO notifications (id, user_id, role, type, priority, title, body, ticket_id)
         VALUES ($1,$2,'agent','sla_breach','critical',$3,$4,$5)
         RETURNING id, user_id, role, type, priority, title, body, ticket_id, read, created_at`,
        [id, assigned_to, title, body, ticket_id]
      );
      created.push(rows[0]);
      emitToAgent(assigned_to, 'notification:new', { notification: rows[0] });
    }

    // Notify all supervisors
    const { rows: supers } = await pool.query(
      `SELECT id FROM users WHERE role IN ('supervisor','admin','super_admin') AND active = TRUE`
    );
    for (const s of supers) {
      const id = uuidv4();
      const { rows } = await pool.query(
        `INSERT INTO notifications (id, user_id, role, type, priority, title, body, ticket_id)
         VALUES ($1,$2,'supervisor','sla_breach','critical',$3,$4,$5)
         RETURNING id, user_id, role, type, priority, title, body, ticket_id, read, created_at`,
        [id, s.id, title, body, ticket_id]
      );
      created.push(rows[0]);
      emitToAgent(s.id, 'notification:new', { notification: rows[0] });
    }

    res.json({ created: created.length });
  } catch (err) {
    console.error('[notifications] sla-breach error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
