'use strict';

const router = require('express').Router();
const { checkAuth, handleAutoAssign } = require('../lib/autoAssign');
const { emitToTicket, emitToAll } = require('../lib/sockets');

// Auth guard
router.use((req, res, next) => {
  if (!checkAuth(req.headers['x-internal-secret'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

router.post('/tickets/:id/auto-assign', async (req, res) => {
  try {
    const { status, body } = await handleAutoAssign(req.params.id, req.body);
    res.status(status).json(body);
  } catch (err) {
    console.error('[internal/auto-assign]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/internal/emit — called by Python API to broadcast socket events to dashboard agents
// Body: { event: string, ticket_id?: string, payload?: object }
router.post('/emit', (req, res) => {
  const { event, ticket_id, payload } = req.body;
  if (!event) return res.status(400).json({ error: 'Missing event' });
  console.log(`[internal/emit] ${event} ticket=${ticket_id ?? 'broadcast'}`);
  if (ticket_id) {
    emitToTicket(ticket_id, event, payload ?? {});
  } else {
    emitToAll(event, payload ?? {});
  }
  res.json({ ok: true });
});

module.exports = router;
