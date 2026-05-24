'use strict';

const router = require('express').Router();
const { checkAuth, handleAutoAssign } = require('../lib/autoAssign');

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

module.exports = router;
