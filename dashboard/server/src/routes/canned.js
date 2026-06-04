// /api/canned-responses
const router = require('express').Router();
const pool   = require('../db/pg');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM canned_responses
       WHERE scope='shared' OR owner_id=$1
       ORDER BY shortcut ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { shortcut, title, body, scope = 'shared' } = req.body;
  if (!shortcut || !title || !body) return res.status(400).json({ error: 'shortcut, title, body required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO canned_responses (shortcut, title, body, scope, owner_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [shortcut, title, body, scope, scope === 'personal' ? req.user.id : null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { shortcut, title, body, scope } = req.body;
  if (!shortcut || !title || !body || !scope) return res.status(400).json({ error: 'shortcut, title, body, scope required' });
  try {
    const { rows } = await pool.query(
      `UPDATE canned_responses SET shortcut=$1, title=$2, body=$3, scope=$4::text,
       owner_id=CASE WHEN $4::text='personal' THEN $5::uuid ELSE NULL END
       WHERE id=$6 RETURNING *`,
      [shortcut, title, body, scope, req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM canned_responses WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
