// /api/bot-config — Bot Config feature flags + curated quick-reply pill library
const router = require('express').Router();
const pool   = require('../db/pg');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate, requirePermission('admin.bot_config'));

// ── GET /api/bot-config ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM bot_config');
    const cfg = {
      quick_replies_enabled: true,
      quick_replies_mode: 'ai',
    };
    for (const row of rows) {
      try { cfg[row.key] = JSON.parse(row.value); } catch { cfg[row.key] = row.value; }
    }
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/bot-config ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { quick_replies_enabled, quick_replies_mode } = req.body;
    const updates = [];
    if (quick_replies_enabled !== undefined)
      updates.push(['quick_replies_enabled', JSON.stringify(quick_replies_enabled)]);
    if (quick_replies_mode !== undefined)
      updates.push(['quick_replies_mode', JSON.stringify(quick_replies_mode)]);

    for (const [key, value] of updates) {
      await pool.query(
        `INSERT INTO bot_config (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/bot-config/curated-pills ────────────────────────────────────────
router.get('/curated-pills', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT category, language, pills FROM curated_quick_replies ORDER BY category, language'
    );
    const result = {};
    for (const row of rows) {
      if (!result[row.category]) result[row.category] = {};
      result[row.category][row.language] = row.pills;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/bot-config/curated-pills ────────────────────────────────────────
router.put('/curated-pills', async (req, res) => {
  try {
    const { pills } = req.body;
    if (!pills || typeof pills !== 'object') {
      return res.status(400).json({ error: 'pills must be an object' });
    }
    for (const [category, langs] of Object.entries(pills)) {
      for (const [language, pillList] of Object.entries(langs)) {
        await pool.query(
          `INSERT INTO curated_quick_replies (category, language, pills, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (category, language) DO UPDATE SET pills = $3::jsonb, updated_at = NOW()`,
          [category, language, JSON.stringify(pillList)]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
