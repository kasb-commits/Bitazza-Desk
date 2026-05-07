// POST /api/auth/login  →  { token, user: { ...fields, permissions[] } }
// GET  /api/auth/me     →  { id, name, email, role, team, permissions[] }
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../db/pg');
const { authenticate, signToken, getPermissionsForRole } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash, role, team, state, avatar_url FROM users WHERE email = $1 AND active = true',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const [token, permissions] = await Promise.all([
      signToken(user),
      getPermissionsForRole(user.role),
    ]);

    const { password_hash: _, ...safeUser } = user;
    res.json({ token, user: { ...safeUser, permissions } });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me — validate token + return fresh profile/permissions
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role, team, avatar_url FROM users WHERE id = $1 AND active = true',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const permissions = await getPermissionsForRole(user.role);
    res.json({ ...user, id: String(user.id), permissions });
  } catch (err) {
    console.error('[auth] me error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
