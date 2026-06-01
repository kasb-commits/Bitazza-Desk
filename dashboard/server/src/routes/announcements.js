// /api/announcements — CRUD for CS admins
const router = require('express').Router();
const pool   = require('../db/pg');
const { authenticate, requirePermission } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(authenticate, requirePermission('admin.announcements'));

// ── GET /api/announcements ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title_en, body_en, title_th, body_th, color,
              active, starts_at, ends_at, created_by, created_at, updated_at
       FROM announcements
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[announcements] GET error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/announcements ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { title_en, body_en, title_th, body_th, active, starts_at, ends_at, color } = req.body;
  if (!title_en || !body_en || !title_th || !body_th) {
    return res.status(400).json({ error: 'title_en, body_en, title_th, body_th are required' });
  }
  try {
    const id = uuidv4();
    const { rows } = await pool.query(
      `INSERT INTO announcements
         (id, title_en, body_en, title_th, body_th, color, active, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [id, title_en, body_en, title_th, body_th,
       color || null,
       active ?? false,
       starts_at || null,
       ends_at   || null,
       req.user?.id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[announcements] POST error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/announcements/:id ────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { title_en, body_en, title_th, body_th, active, starts_at, ends_at, color } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE announcements SET
         title_en  = COALESCE($1, title_en),
         body_en   = COALESCE($2, body_en),
         title_th  = COALESCE($3, title_th),
         body_th   = COALESCE($4, body_th),
         active    = COALESCE($5, active),
         starts_at = $6,
         ends_at   = $7,
         color     = $8,
         updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [title_en, body_en, title_th, body_th,
       active ?? null,
       starts_at !== undefined ? starts_at || null : undefined,
       ends_at   !== undefined ? ends_at   || null : undefined,
       color !== undefined ? color || null : undefined,
       id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[announcements] PUT error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/announcements/:id/toggle ──────────────────────────────────────
router.patch('/:id/toggle', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE announcements
       SET active = NOT active, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[announcements] PATCH toggle error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/announcements/:id ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM announcements WHERE id = $1', [id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[announcements] DELETE error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
