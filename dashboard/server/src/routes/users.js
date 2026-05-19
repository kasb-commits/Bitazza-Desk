// GET /api/users             — paginated customer list (alphabetical, 25/page)
// GET /api/users/search        — search user by uid, email, or phone
// GET /api/users/:uid/profile  — full profile (KYC, balances, etc.)
// GET /api/users/:uid/transactions   — paginated deposit/withdrawal history
// GET /api/users/:uid/spot-trades    — paginated spot trade history
// GET /api/users/:uid/futures-trades — paginated futures trade history
// GET /api/users/:uid/tickets        — all CS tickets for this user (from our DB)
const router  = require('express').Router();
const pool    = require('../db/pg');
const { requirePermission } = require('../middleware/auth');

async function auditLog(pool, actorId, action, targetUserId) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, metadata)
       VALUES ($1, $2, 'user', $3)`,
      [actorId, action, JSON.stringify({ searched_uid: targetUserId })]
    );
  } catch { /* non-fatal */ }
}

const MOCK_API_URL = process.env.MOCK_API_URL || 'http://localhost:8000';
const MOCK_API_TOKEN = process.env.MOCK_API_TOKEN || 'dev-token';

async function mockFetch(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${MOCK_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${MOCK_API_TOKEN}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function validateUid(uid) {
  return /^[\w-]+$/.test(uid);
}

// List: GET /api/users?page=1&page_size=25
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const page_size = Math.min(100, parseInt(req.query.page_size) || 25);
  const offset = (page - 1) * page_size;
  try {
    const [countRes, rowsRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM customers'),
      pool.query(
        `SELECT id, bitazza_uid, external_id, name, email, phone, tier, kyc_status, kyc_tier, created_at
         FROM customers
         ORDER BY name ASC NULLS LAST
         LIMIT $1 OFFSET $2`,
        [page_size, offset]
      ),
    ]);
    res.json({
      total: countRes.rows[0].total,
      page,
      page_size,
      items: rowsRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search: GET /api/users/search?q=...&by=uid|email|phone
router.get('/search', async (req, res) => {
  const { q, by = 'uid' } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  const param = by === 'email' ? 'email' : by === 'phone' ? 'phone' : 'user_id';
  try {
    const profile = await mockFetch(`/mock/user?${param}=${encodeURIComponent(q)}`);
    const restrictions = await mockFetch(`/mock/restrictions?user_id=${encodeURIComponent(profile.user_id)}`);
    await auditLog(pool, req.user.id, 'user360_search', profile.user_id);
    res.json({ ...profile, restrictions });
  } catch (err) {
    if (err.message.includes('404') || err.message.includes('upstream 404')) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(503).json({ error: 'User lookup unavailable' });
  }
});

// Profile: GET /api/users/:uid/profile
router.get('/:uid/profile', async (req, res) => {
  if (!validateUid(req.params.uid)) return res.status(400).json({ error: 'Invalid uid' });
  try {
    const [profile, restrictions] = await Promise.all([
      mockFetch(`/mock/user?user_id=${encodeURIComponent(req.params.uid)}`),
      mockFetch(`/mock/restrictions?user_id=${encodeURIComponent(req.params.uid)}`),
    ]);
    await auditLog(pool, req.user.id, 'user360_profile_view', req.params.uid);
    // Strip KYC detail unless caller has user360.kyc
    const perms = req.user.permissions ?? [];
    if (!perms.includes('user360.kyc') && profile.kyc) {
      profile.kyc = { status: profile.kyc.status };
    }
    res.json({ ...profile, restrictions });
  } catch (err) {
    if (err.message.includes('404')) return res.status(404).json({ error: 'User not found' });
    res.status(503).json({ error: 'Profile unavailable' });
  }
});

// Transactions: GET /api/users/:uid/transactions?page=1&page_size=20
router.get('/:uid/transactions', requirePermission('user360.financials'), async (req, res) => {
  if (!validateUid(req.params.uid)) return res.status(400).json({ error: 'Invalid uid' });
  const { page = 1, page_size = 20 } = req.query;
  try {
    const data = await mockFetch(`/mock/transactions?user_id=${encodeURIComponent(req.params.uid)}&page=${page}&page_size=${page_size}`);
    res.json(data);
  } catch (err) {
    if (err.message.includes('404')) return res.status(404).json({ error: 'User not found' });
    res.status(503).json({ error: 'Transaction history unavailable' });
  }
});

// Spot trades: GET /api/users/:uid/spot-trades?page=1&page_size=20
router.get('/:uid/spot-trades', requirePermission('user360.financials'), async (req, res) => {
  if (!validateUid(req.params.uid)) return res.status(400).json({ error: 'Invalid uid' });
  const { page = 1, page_size = 20 } = req.query;
  try {
    const data = await mockFetch(`/mock/spot-trades?user_id=${encodeURIComponent(req.params.uid)}&page=${page}&page_size=${page_size}`);
    res.json(data);
  } catch (err) {
    if (err.message.includes('404')) return res.status(404).json({ error: 'User not found' });
    res.status(503).json({ error: 'Spot trade history unavailable' });
  }
});

// Futures trades: GET /api/users/:uid/futures-trades?page=1&page_size=20
router.get('/:uid/futures-trades', requirePermission('user360.financials'), async (req, res) => {
  if (!validateUid(req.params.uid)) return res.status(400).json({ error: 'Invalid uid' });
  const { page = 1, page_size = 20 } = req.query;
  try {
    const data = await mockFetch(`/mock/futures-trades?user_id=${encodeURIComponent(req.params.uid)}&page=${page}&page_size=${page_size}`);
    res.json(data);
  } catch (err) {
    if (err.message.includes('404')) return res.status(404).json({ error: 'User not found' });
    res.status(503).json({ error: 'Futures trade history unavailable' });
  }
});

// Ticket history: GET /api/users/:uid/tickets
// Looks up by customer.external_id (bitazza_uid) or customer email
router.get('/:uid/tickets', requirePermission('user360.tickets'), async (req, res) => {
  if (!validateUid(req.params.uid)) return res.status(400).json({ error: 'Invalid uid' });
  try {
    const { rows } = await pool.query(`
      SELECT
        t.id, t.status, t.priority, t.channel, t.category, t.tags,
        t.created_at, t.updated_at, t.assigned_to,
        c.name AS customer_name, c.email AS customer_email,
        u.name AS assigned_to_name,
        (SELECT content FROM messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message
      FROM tickets t
      LEFT JOIN customers c ON t.customer_id = c.id
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE c.external_id = $1 OR c.bitazza_uid = $1
      ORDER BY t.created_at DESC
      LIMIT 100
    `, [req.params.uid]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Balances: GET /api/users/:uid/balances
router.get('/:uid/balances', requirePermission('user360.financials'), async (req, res) => {
  if (!validateUid(req.params.uid)) return res.status(400).json({ error: 'Invalid uid' });
  try {
    const data = await mockFetch(`/mock/balances?user_id=${encodeURIComponent(req.params.uid)}`);
    res.json(data);
  } catch (err) {
    if (err.message.includes('404')) return res.status(404).json({ error: 'User not found' });
    res.status(503).json({ error: 'Balance data unavailable' });
  }
});

module.exports = router;
