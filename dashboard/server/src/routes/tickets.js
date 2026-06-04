// /api/tickets — CRUD + messages + claim + assign + escalate
const router   = require('express').Router();
const pool     = require('../db/pg');
const sanitizeHtml = require('sanitize-html');

const RICH_TEXT_ALLOWED_TAGS = ['p','strong','em','u','s','h2','h3','ul','ol','li','a','br','blockquote','code'];
const RICH_TEXT_SANITIZE_OPTS = {
  allowedTags: RICH_TEXT_ALLOWED_TAGS,
  allowedAttributes: { a: ['href', 'target', 'rel'] },
};

function sanitizeContent(raw) {
  if (!raw) return raw;
  return sanitizeHtml(raw, RICH_TEXT_SANITIZE_OPTS);
}
const { authenticate, requireRole, requirePermission } = require('../middleware/auth');
const { claimTicketLock, releaseTicketLock, pushQueueBack, pushQueueFront, getAgentSession, keys } = require('../lib/redis');
const { emitToTicket, emitToSupervisors, emitToAgent } = require('../lib/sockets');
const { v4: uuidv4 } = require('uuid');

// ── Inline system message helper ─────────────────────────────────────────────
// Inserts a system message row and broadcasts it as a new_message WS event so
// all agents viewing the thread see it in real-time without a manual refresh.
async function insertSystemMsg(ticketId, actorId, content) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (ticket_id, sender_type, sender_id, content)
       VALUES ($1, 'system', $2, $3) RETURNING *`,
      [ticketId, actorId || null, content]
    );
    const msg = rows[0];
    emitToTicket(ticketId, 'new_message', {
      message: {
        id: msg.id,
        role: 'system',
        sender_type: 'system',
        content: msg.content,
        created_at: Math.floor(new Date(msg.created_at).getTime() / 1000),
      },
    });
  } catch (err) {
    console.error('[system-msg] failed to insert:', err.message);
  }
}

const STATUS_LABELS = {
  Open_Live: 'Open (Live)',
  In_Progress: 'In Progress',
  Pending_Customer: 'Pending Customer',
  Closed_Resolved: 'Closed (Resolved)',
  Closed_Unresponsive: 'Closed (Unresponsive)',
  Escalated: 'Escalated',
  Orphaned: 'Orphaned',
};

const PRIORITY_LABELS = { 1: 'VIP', 2: 'EA', 3: 'Standard' };

// ── FR-02 Push routing | FR-04 Sticky routing | FR-05 VIP override ────────────
// Returns assigned agent ID or null (queued).
async function routeTicket(ticketId, customerId, priority, team = 'default') {
  // FR-04: Sticky — look for the agent who last handled this customer (window from DB rule)
  let stickyAgentId = null;
  try {
    const rules = await getAssignmentRules();
    const stickyHours = Number(rules['sticky_agent_hours'] ?? 12);
    const { rows } = await pool.query(`
      SELECT t.assigned_to
      FROM tickets t
      WHERE t.customer_id = $1
        AND t.assigned_to IS NOT NULL
        AND t.updated_at >= NOW() - ($2 || ' hours')::interval
      ORDER BY t.updated_at DESC
      LIMIT 1
    `, [customerId, String(stickyHours)]);
    stickyAgentId = rows[0]?.assigned_to ?? null;
  } catch { /* non-fatal */ }

  // FR-02: Find available agents (Available state, under capacity) ordered by
  // last_assigned_at ASC (least recently used first).
  const { rows: agents } = await pool.query(`
    SELECT u.id, u.max_chats,
      COUNT(t2.id) FILTER (WHERE t2.status NOT IN ('Closed_Resolved','Closed_Unresponsive')) AS active_chats,
      MAX(t2.updated_at) AS last_assigned_at
    FROM users u
    LEFT JOIN tickets t2 ON t2.assigned_to = u.id
    WHERE u.role IN ('agent','supervisor')
      AND ($1::text IS NULL OR u.team = $1)
    GROUP BY u.id, u.max_chats
    HAVING COUNT(t2.id) FILTER (WHERE t2.status NOT IN ('Closed_Resolved','Closed_Unresponsive')) < u.max_chats
    ORDER BY last_assigned_at ASC NULLS FIRST
  `, [team === 'default' ? null : team]);

  // Filter to Available agents by checking Redis session state
  const availableAgents = [];
  for (const a of agents) {
    try {
      const session = await getAgentSession(a.id);
      if (session?.state === 'Available') availableAgents.push(a);
    } catch { /* Redis down — fall back to DB-only list */ availableAgents.push(a); }
  }

  let assignedTo = null;

  if (stickyAgentId && availableAgents.some(a => a.id === stickyAgentId)) {
    // FR-04: sticky agent is available — assign to them
    assignedTo = stickyAgentId;
  } else if (availableAgents.length > 0) {
    // FR-02: round-robin (least recently assigned)
    assignedTo = availableAgents[0].id;
  }

  if (assignedTo) {
    const rules = await getAssignmentRules();
    const slaConfig = typeof rules['sla_minutes'] === 'string' ? JSON.parse(rules['sla_minutes']) : (rules['sla_minutes'] ?? { '1': 1, '2': 3, '3': 10 });
    const slaMinutes = slaConfig[String(priority)] ?? (priority === 1 ? 1 : priority === 2 ? 3 : 10);
    await pool.query(
      `UPDATE tickets SET assigned_to=$1, status='Open_Live',
         sla_deadline=NOW() + ($2 || ' minutes')::interval, updated_at=NOW()
       WHERE id=$3`,
      [assignedTo, String(slaMinutes), ticketId]
    );
    const { rows: agentInfo } = await pool.query(
      'SELECT name, avatar_url FROM users WHERE id=$1', [assignedTo]
    );
    await insertSystemMsg(ticketId, null,
      `Auto-assigned to ${agentInfo[0]?.name ?? 'an agent'}`);
    emitToAgent(assignedTo, 'ticket:assigned', {
      ticketId,
      agentId: assignedTo,
      agentName: agentInfo[0]?.name ?? null,
      agentAvatarUrl: agentInfo[0]?.avatar_url ?? null,
    });
    return assignedTo;
  }

  // No available agent — queue it
  // FR-05: VIP (priority=1) goes to front of queue
  if (priority === 1) {
    await pushQueueFront(team, ticketId);
  } else {
    await pushQueueBack(team, ticketId);
  }

  emitToSupervisors('capacity:zero_alert', { ticketId, team, priority });
  return null;
}

// All ticket routes require auth
router.use(authenticate);

// ── GET /api/tickets/stats ────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const SCOPED_ROLES = ['agent', 'kyc_agent', 'finance_agent'];
  const teamFilter = SCOPED_ROLES.includes(req.user.role)
    ? `WHERE team = $1`
    : '';
  const teamParams = SCOPED_ROLES.includes(req.user.role) ? [req.user.team] : [];
  try {
    const { rows } = await pool.query(
      `SELECT status, COUNT(*) AS count FROM tickets ${teamFilter} GROUP BY status`,
      teamParams
    );
    const counts = Object.fromEntries(rows.map(r => [r.status, parseInt(r.count)]));
    res.json({
      open:       (counts['Open_Live'] ?? 0) + (counts['In_Progress'] ?? 0),
      active:     counts['In_Progress'] ?? 0,
      escalated:  counts['Escalated'] ?? 0,
      pending:    counts['Pending_Customer'] ?? 0,
      resolved:   counts['Closed_Resolved'] ?? 0,
      closed:     counts['Closed_Unresponsive'] ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tickets ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { view = 'all_open', search = '', limit = 50, offset = 0, status_filter = 'all', channel_filter = 'all' } = req.query;
  const agentId = req.user.id;

  let whereClauses = [];
  let params = [];
  let p = 1;

  const addParam = (val) => { params.push(val); return `$${p++}`; };

  // View filters (skip status restrictions when an explicit status_filter is set, or when 'all' is requested)
  const hasStatusFilter = status_filter && status_filter !== 'all';
  switch (view) {
    case 'mine':
      whereClauses.push(`t.assigned_to = ${addParam(agentId)}`);
      if (!hasStatusFilter && status_filter !== 'all') whereClauses.push(`t.status NOT IN ('Closed_Resolved','Closed_Unresponsive')`);
      break;
    case 'unassigned':
      whereClauses.push(`t.assigned_to IS NULL`);
      if (!hasStatusFilter && status_filter !== 'all') whereClauses.push(`t.status NOT IN ('Closed_Resolved','Closed_Unresponsive')`);
      break;
    case 'sla_risk':
      whereClauses.push(`t.sla_deadline < NOW() + INTERVAL '30 minutes'`);
      whereClauses.push(`t.sla_breached = false`);
      if (!hasStatusFilter && status_filter !== 'all') whereClauses.push(`t.status NOT IN ('Closed_Resolved','Closed_Unresponsive')`);
      break;
    case 'waiting':
      whereClauses.push(`t.status = 'Pending_Customer'`);
      break;
    case 'by_priority':
      if (!hasStatusFilter && status_filter !== 'all') whereClauses.push(`t.status NOT IN ('Closed_Resolved','Closed_Unresponsive')`);
      break;
    case 'all':
      break;
    default: // all_open
      if (!hasStatusFilter && status_filter !== 'all') whereClauses.push(`t.status NOT IN ('Closed_Resolved','Closed_Unresponsive')`);
  }

  if (hasStatusFilter) {
    whereClauses.push(`t.status = ${addParam(status_filter)}`);
  }

  if (channel_filter === 'email') {
    whereClauses.push(`t.channel = ${addParam('email')}`);
  } else if (channel_filter === 'web') {
    whereClauses.push(`t.channel = ${addParam('web')}`);
  } else if (channel_filter === 'app') {
    whereClauses.push(`t.channel IN ('line', 'facebook')`);
  }

  // Team scoping: agents only see tickets belonging to their team.
  // Supervisors, admins, and super_admins see all teams.
  const SCOPED_ROLES = ['agent', 'kyc_agent', 'finance_agent'];
  if (SCOPED_ROLES.includes(req.user.role)) {
    whereClauses.push(`t.team = ${addParam(req.user.team)}`);
  }

  if (search) {
    const sp = addParam(`%${search}%`);
    whereClauses.push(`(c.name ILIKE ${sp} OR c.email ILIKE ${sp} OR t.id::text ILIKE ${sp} OR EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id = t.id AND m.content ILIKE ${sp}))`);
  }

  const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

  try {
    const sql = `
      SELECT
        t.id, t.status, t.priority, t.channel, t.category, t.tags,
        t.sla_deadline, t.sla_breached, t.created_at, t.updated_at,
        t.assigned_to, t.ai_persona, t.csat_score,
        c.id          AS customer_id,
        c.name        AS customer_name,
        c.email       AS customer_email,
        c.phone       AS customer_phone,
        c.tier        AS customer_tier,
        c.kyc_status  AS customer_kyc_status,
        c.kyc_tier    AS customer_kyc_tier,
        c.external_id AS customer_external_id,
        u.name AS assigned_to_name,
        (SELECT content FROM messages WHERE ticket_id = t.id AND sender_type NOT IN ('system','internal_note') ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT EXTRACT(EPOCH FROM created_at)::bigint FROM messages WHERE ticket_id = t.id AND sender_type NOT IN ('system','internal_note') ORDER BY created_at DESC LIMIT 1) AS last_message_at
      FROM tickets t
      LEFT JOIN customers c ON t.customer_id = c.id
      LEFT JOIN users u ON t.assigned_to = u.id
      ${where}
      ORDER BY COALESCE((SELECT MAX(created_at) FROM messages WHERE ticket_id = t.id), t.created_at) DESC
      LIMIT ${addParam(parseInt(limit))} OFFSET ${addParam(parseInt(offset))}
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(t => ({
      id:               t.id,
      status:           t.status,
      priority:         t.priority,
      channel:          t.channel,
      category:         t.category,
      tags:             t.tags ?? [],
      sla_deadline:     t.sla_deadline,
      sla_breached:     t.sla_breached,
      created_at:       t.created_at,
      updated_at:       t.updated_at,
      assigned_to:      t.assigned_to,
      assigned_to_name: t.assigned_to_name,
      ai_persona:       t.ai_persona ?? null,
      csat_score:       t.csat_score ?? null,
      last_message:     t.last_message,
      last_message_at:  t.last_message_at,
      customer: {
        id:         t.customer_id,
        user_id:    t.customer_external_id ?? t.customer_id,
        name:       t.customer_name  ?? '—',
        email:      t.customer_email ?? null,
        phone:      t.customer_phone ?? null,
        tier:       t.customer_tier  ?? 'Standard',
        kyc_status: t.customer_kyc_status ?? null,
        kyc_tier:   t.customer_kyc_tier ?? 0,
      },
    })));
  } catch (err) {
    console.error('[tickets] list error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/tickets/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows: tRows } = await pool.query(`
      SELECT t.*, c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
             c.phone AS customer_phone, c.tier AS customer_tier,
             c.kyc_status AS customer_kyc_status, c.kyc_tier AS customer_kyc_tier,
             c.external_id AS customer_external_id,
             c.bitazza_uid, c.line_uid, c.fb_psid,
             u.name AS assigned_to_name
      FROM tickets t
      LEFT JOIN customers c ON t.customer_id = c.id
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = $1
    `, [req.params.id]);

    if (!tRows.length) return res.status(404).json({ error: 'Not found' });

    const { rows: msgs } = await pool.query(
      'SELECT * FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    const ticket = tRows[0];
    res.json({
      ...ticket,
      customer: {
        id:         ticket.customer_id,
        user_id:    ticket.customer_external_id ?? ticket.customer_id,
        name:       ticket.customer_name  ?? '—',
        email:      ticket.customer_email ?? null,
        phone:      ticket.customer_phone ?? null,
        tier:       ticket.customer_tier  ?? 'Standard',
        kyc_status: ticket.customer_kyc_status ?? null,
        kyc_tier:   ticket.customer_kyc_tier ?? 0,
        bitazza_uid: ticket.bitazza_uid,
        line_uid:   ticket.line_uid,
        fb_psid:    ticket.fb_psid,
      },
      history: msgs.map(m => {
        let meta = m.metadata ?? {};
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
        return {
          id: m.id,
          role: m.sender_type,
          sender_type: m.sender_type,
          content: m.content,
          agent_name: meta.agent_name ?? null,
          agent_avatar_url: meta.agent_avatar_url ?? null,
          is_internal_note: m.sender_type === 'internal_note',
          created_at: Math.floor(new Date(m.created_at).getTime() / 1000),
          metadata: meta,
        };
      }),
    });
  } catch (err) {
    console.error('[tickets] get error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/tickets/:id/status ────────────────────────────────────────────
router.patch('/:id/status', requirePermission('inbox.close'), async (req, res) => {
  const { status } = req.body;
  const valid = ['Open_Live','In_Progress','Pending_Customer','Closed_Resolved','Closed_Unresponsive','Orphaned','Escalated'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await pool.query('UPDATE tickets SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    await insertSystemMsg(req.params.id, req.user.id,
      `${req.user.name} changed status to ${STATUS_LABELS[status] || status}`);
    emitToTicket(req.params.id, 'ticket:updated', { ticketId: req.params.id, changes: { status } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/tickets/:id/priority ──────────────────────────────────────────
router.patch('/:id/priority', async (req, res) => {
  const { priority } = req.body;
  if (![1,2,3].includes(Number(priority))) return res.status(400).json({ error: 'Invalid priority' });
  try {
    await pool.query('UPDATE tickets SET priority=$1, updated_at=NOW() WHERE id=$2', [priority, req.params.id]);
    await insertSystemMsg(req.params.id, req.user.id,
      `${req.user.name} changed priority to ${PRIORITY_LABELS[Number(priority)] || priority}`);
    emitToTicket(req.params.id, 'ticket:updated', { ticketId: req.params.id, changes: { priority } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/tickets/:id/assign ────────────────────────────────────────────
// FR-14: owner_id NEVER changes; only assigned_to + team update
router.patch('/:id/assign', requirePermission('inbox.assign'), async (req, res) => {
  const { assigned_to, team, handoff_note } = req.body;
  try {
    // Get previous assignee before overwriting
    const { rows: prev } = await pool.query(
      `SELECT assigned_to FROM tickets WHERE id=$1`, [req.params.id]
    );
    const prevAgent = prev[0]?.assigned_to ?? null;

    await pool.query(
      `UPDATE tickets SET assigned_to=$1, team=COALESCE($2,team), updated_at=NOW() WHERE id=$3`,
      [assigned_to || null, team || null, req.params.id]
    );

    // Keep active_chats in sync
    if (prevAgent && prevAgent !== (assigned_to || null)) {
      await pool.query(
        `UPDATE users SET active_chats = GREATEST(0, active_chats - 1) WHERE id=$1`, [prevAgent]
      );
    }
    if (assigned_to && assigned_to !== prevAgent) {
      await pool.query(
        `UPDATE users SET active_chats = active_chats + 1 WHERE id=$1`, [assigned_to]
      );
    }
    let agentName = null, agentAvatarUrl = null;
    if (assigned_to) {
      const { rows: ai } = await pool.query('SELECT name, avatar_url FROM users WHERE id=$1', [assigned_to]);
      agentName = ai[0]?.name ?? null;
      agentAvatarUrl = ai[0]?.avatar_url ?? null;
    }
    let assignMsg = assigned_to
      ? `${req.user.name} assigned this ticket to ${agentName || 'an agent'}`
      : `${req.user.name} unassigned this ticket`;
    if (handoff_note) assignMsg += ` — ${handoff_note}`;
    await insertSystemMsg(req.params.id, req.user.id, assignMsg);
    emitToTicket(req.params.id, 'ticket:assigned', {
      ticketId: req.params.id,
      agentId: assigned_to,
      agentName,
      agentAvatarUrl,
    });

    // Notify the newly assigned agent
    if (assigned_to && assigned_to !== prevAgent) {
      const { rows: ticketInfo } = await pool.query(
        `SELECT c.name as customer_name, t.channel
         FROM tickets t JOIN customers c ON t.customer_id = c.id
         WHERE t.id = $1`, [req.params.id]
      );
      const customerName = ticketInfo[0]?.customer_name || 'A customer';
      const channel = ticketInfo[0]?.channel || 'web';
      const notifId = uuidv4();
      const { rows: notifRows } = await pool.query(
        `INSERT INTO notifications (id, user_id, role, type, priority, title, body, ticket_id)
         VALUES ($1,$2,'agent','assigned','medium',$3,$4,$5)
         RETURNING id, user_id, role, type, priority, title, body, ticket_id, read, created_at`,
        [
          notifId, assigned_to,
          `Ticket #${req.params.id.slice(0, 8)} assigned to you`,
          `From ${customerName} — ${channel} channel`,
          req.params.id,
        ]
      );
      emitToAgent(assigned_to, 'notification:new', { notification: notifRows[0] });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/tickets/:id/tags ───────────────────────────────────────────────
router.patch('/:id/tags', async (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be array' });
  try {
    await pool.query('UPDATE tickets SET tags=$1, updated_at=NOW() WHERE id=$2', [tags, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tickets/:id/messages ───────────────────────────────────────────
router.post('/:id/messages', requirePermission('inbox.reply'), async (req, res) => {
  const { content, is_note = false, channel, attachment_ids } = req.body;
  if (!content?.trim() && !attachment_ids?.length) return res.status(400).json({ error: 'content or attachment required' });

  const senderType = is_note ? 'internal_note' : 'agent';
  // Validate channel if provided (FR-08)
  const VALID_CHANNELS = ['web', 'line', 'facebook', 'email'];
  const replyChannel = VALID_CHANNELS.includes(channel) ? channel : null;

  // Resolve attachment metadata from the Python uploads store
  let attachments = [];
  if (!is_note && Array.isArray(attachment_ids) && attachment_ids.length) {
    try {
      const uploadsDir = require('path').join(__dirname, '..', '..', 'uploads', 'attachments');
      const fs = require('fs');
      const mime = require('mime-types');
      attachments = attachment_ids.flatMap(aid => {
        const match = fs.readdirSync(uploadsDir).find(f => f.startsWith(aid + '_'));
        if (!match) return [];
        const name = match.slice(aid.length + 1);
        const fpath = require('path').join(uploadsDir, match);
        const size = fs.statSync(fpath).size;
        const mimeType = mime.lookup(match) || 'application/octet-stream';
        const host = `${req.protocol}://${req.get('host')}`;
        return [{ id: aid, url: `${host}/uploads/attachments/${match}`, name, mime_type: mimeType, size }];
      });
    } catch { /* uploads dir may not exist yet */ }
  }

  try {
    const rawAvatarUrl = req.user.avatar_url ?? null;
    const agentAvatarUrl = rawAvatarUrl && rawAvatarUrl.startsWith('/')
      ? `${req.protocol}://${req.get('host')}${rawAvatarUrl}`
      : rawAvatarUrl;
    const msgMeta = {
      agent_name: req.user.name,
      agent_avatar_url: agentAvatarUrl,
      ...(replyChannel ? { channel: replyChannel } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    const safeContent = sanitizeContent((content ?? '').trim());
    const { rows } = await pool.query(
      `INSERT INTO messages (ticket_id, sender_type, sender_id, content, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, senderType, req.user.id, safeContent, JSON.stringify(msgMeta)]
    );
    // Update ticket status to In_Progress on first agent reply
    if (!is_note) {
      await pool.query(
        `UPDATE tickets SET status='In_Progress', updated_at=NOW() WHERE id=$1 AND status='Open_Live'`,
        [req.params.id]
      );
    }
    const msg = rows[0];
    emitToTicket(req.params.id, 'new_message', {
      message: {
        id: msg.id,
        role: msg.sender_type,
        sender_type: msg.sender_type,
        content: msg.content,
        agent_name: req.user.name,
        agent_avatar_url: agentAvatarUrl,
        is_internal_note: senderType === 'internal_note',
        created_at: Math.floor(new Date(msg.created_at).getTime() / 1000),
        metadata: msgMeta,
      },
    });
    res.json({ ok: true, message: msg });

    // If ticket channel is email and this is not an internal note, send the reply via Gmail
    if (!is_note) {
      const ticketRow = await pool.query(`SELECT channel FROM tickets WHERE id=$1`, [req.params.id]);
      if (ticketRow.rows[0]?.channel === 'email') {
        try {
          await fetch(`${process.env.PYTHON_API_URL || 'http://localhost:8000'}/api/tickets/${req.params.id}/email-reply`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || 'internal-dev-token',
            },
            body: JSON.stringify({
              message: safeContent,
              agent_name: req.user.name,
              // Pass resolved attachment metadata so the Python email sender can embed them inline
              attachments: attachments.length ? attachments : undefined,
            }),
          });
        } catch (emailErr) {
          console.error('Failed to send agent email reply:', emailErr.message);
        }
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tickets/:id/claim (FR-03 email pull) ───────────────────────────
router.post('/:id/claim', requirePermission('inbox.claim'), async (req, res) => {
  const ticketId = req.params.id;
  const won = await claimTicketLock(ticketId);
  if (!won) {
    // Find who has it
    const { rows } = await pool.query(
      'SELECT u.name FROM tickets t JOIN users u ON t.assigned_to=u.id WHERE t.id=$1',
      [ticketId]
    );
    const name = rows[0]?.name ?? 'another agent';
    return res.status(409).json({ error: `Ticket already claimed by ${name}` });
  }
  try {
    await pool.query(
      `UPDATE tickets SET assigned_to=$1, owner_id=COALESCE(owner_id,$1), status='In_Progress', updated_at=NOW() WHERE id=$2`,
      [req.user.id, ticketId]
    );
    await releaseTicketLock(ticketId);
    const { rows: ai } = await pool.query('SELECT name, avatar_url FROM users WHERE id=$1', [req.user.id]);
    await insertSystemMsg(ticketId, req.user.id,
      `${ai[0]?.name ?? 'An agent'} took over this conversation`);
    emitToTicket(ticketId, 'ticket:assigned', {
      ticketId,
      agentId: req.user.id,
      agentName: ai[0]?.name ?? null,
      agentAvatarUrl: ai[0]?.avatar_url ?? null,
    });
    res.json({ ok: true });
  } catch (err) {
    await releaseTicketLock(ticketId);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tickets/:id/resolve-request ────────────────────────────────────
// Human agent triggers a closure confirmation prompt in the customer widget.
router.post('/:id/resolve-request', requirePermission('inbox.reply'), async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO messages (ticket_id, sender_type, sender_id, content, metadata)
       VALUES ($1, 'system', $2, '__resolve_request__', $3)`,
      [req.params.id, req.user.id, JSON.stringify({ agent_name: req.user.name })]
    );
    await pool.query(
      `UPDATE tickets SET status='Pending_Customer', updated_at=NOW() WHERE id=$1 AND status NOT IN ('Closed_Resolved','Closed_Unresponsive')`,
      [req.params.id]
    );
    emitToTicket(req.params.id, 'ticket:resolve_request', {
      ticketId: req.params.id,
      agentName: req.user.name,
    });
    emitToTicket(req.params.id, 'ticket:updated', { ticketId: req.params.id, changes: { status: 'Pending_Customer' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tickets/:id/escalate ───────────────────────────────────────────
router.post('/:id/escalate', requirePermission('inbox.escalate'), async (req, res) => {
  const { reason } = req.body;
  try {
    await pool.query(
      `UPDATE tickets SET status='Escalated', updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    await pool.query(
      `INSERT INTO messages (ticket_id, sender_type, content) VALUES ($1,'system',$2)`,
      [req.params.id, `Escalated: ${reason || 'no reason given'}`]
    );
    emitToSupervisors('ticket:escalated', { ticketId: req.params.id, reason });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Load assignment rules from DB (with in-process cache, 60s TTL) ────────────
let _rulesCache = null;
let _rulesCacheAt = 0;

async function getAssignmentRules() {
  if (_rulesCache && Date.now() - _rulesCacheAt < 60_000) return _rulesCache;
  const { rows } = await pool.query(`SELECT key, value FROM assignment_rules`);
  const r = {};
  for (const row of rows) r[row.key] = row.value;
  _rulesCache = r;
  _rulesCacheAt = Date.now();
  return r;
}

// Exported so the assignment-rules PATCH route can bust the cache on save
function bustRulesCache() { _rulesCache = null; }

// ── POST /api/tickets (create) ────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { customer_id, channel, category, priority = 3, team } = req.body;
  if (!customer_id || !channel) return res.status(400).json({ error: 'customer_id and channel required' });
  let p = Number(priority);
  if (![1,2,3].includes(p)) return res.status(400).json({ error: 'priority must be 1, 2, or 3' });
  const id = uuidv4();
  try {
    const rules = await getAssignmentRules();
    const categoryTeamMap = rules['category_team_map'] ?? {};
    const vipAutoPriority1 = rules['vip_auto_priority1'] !== false && rules['vip_auto_priority1'] !== 'false';
    const resolvedTeam = team ?? categoryTeamMap[category] ?? 'cs';

    // FR-05: VIP customers get priority 1 (if rule is enabled)
    const { rows: custRows } = await pool.query('SELECT tier FROM customers WHERE id=$1', [customer_id]);
    const tier = (custRows[0]?.tier ?? '').toLowerCase();
    if (vipAutoPriority1 && tier === 'vip') p = 1;
    else if (p === 3 && (tier === 'ea' || tier === 'high_net_worth')) p = 2;

    const slaConfig = typeof rules['sla_minutes'] === 'string' ? JSON.parse(rules['sla_minutes']) : (rules['sla_minutes'] ?? { '1': 1, '2': 3, '3': 10 });
    const slaMinutes = slaConfig[String(p)] ?? (p === 1 ? 1 : p === 2 ? 3 : 10);
    await pool.query(
      `INSERT INTO tickets (id, customer_id, channel, category, priority, team, sla_deadline)
       VALUES ($1,$2,$3,$4,$5,$6, NOW() + ($7 || ' minutes')::interval)`,
      [id, customer_id, channel, category, p, resolvedTeam, String(slaMinutes)]
    );
    // FR-02/04/05: auto-route on creation
    const assignedTo = await routeTicket(id, customer_id, p, resolvedTeam).catch(err => {
      console.warn('[route] routing failed:', err.message);
      return null;
    });
    res.status(201).json({ id, assigned_to: assignedTo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.bustRulesCache = bustRulesCache;
