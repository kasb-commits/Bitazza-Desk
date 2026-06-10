const express = require('express');
const router  = express.Router();

const LEVEL_MAP = { debug: 'debug', info: 'info', warn: 'warn', error: 'error' };

// POST /api/logs/client
// Receives batched client-side log entries from the dashboard frontend and
// writes them to stdout so they appear in Railway logs alongside server logs.
router.post('/client', (req, res) => {
  const { source = 'dashboard', entries = [] } = req.body ?? {};
  for (const entry of entries) {
    const level  = LEVEL_MAP[entry.level] ?? 'info';
    const { level: _l, ...rest } = entry;
    console[level](`[client:${source}]`, JSON.stringify(rest));
  }
  res.json({ ok: true });
});

module.exports = router;
