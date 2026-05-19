// /api/agents
const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const pool   = require('../db/pg');
const { authenticate, requireRole, requirePermission } = require('../middleware/auth');
const { setAgentSession, getAgentSession } = require('../lib/redis');
const { emitToSupervisors } = require('../lib/sockets');

// ── Role ceiling ──────────────────────────────────────────────────────────────
// Roles that cannot be assigned by 'admin' (only super_admin can)
const SUPER_ADMIN_ONLY_ROLES = ['super_admin'];

function canAssignRole(callerRole, targetRole) {
  if (callerRole === 'super_admin') return true;
  if (callerRole === 'admin') return !SUPER_ADMIN_ONLY_ROLES.includes(targetRole);
  return false;
}

// ── Avatar upload (multer) ────────────────────────────────────────────────────
const AVATARS_DIR = path.join(__dirname, '..', '..', 'uploads', 'avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${req.params.id}_${Date.now()}${ext}`);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// ── Auth ──────────────────────────────────────────────────────────────────────
router.use(authenticate);

// ── GET /api/agents — list agents (supervisor+) ───────────────────────────────
router.get('/', requirePermission('section.supervisor'), async (req, res) => {
  const includeInactive = req.query.include_inactive === 'true';
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.team, u.state, u.max_chats,
              u.skills, u.shift, u.active, u.avatar_url,
              COUNT(t.id) FILTER (WHERE t.status NOT IN ('Closed_Resolved','Closed_Unresponsive','Orphaned')) AS active_chats
       FROM users u
       LEFT JOIN tickets t ON t.assigned_to = u.id
       ${includeInactive ? '' : 'WHERE u.active = true'}
       GROUP BY u.id
       ORDER BY u.name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/agents — create agent ──────────────────────────────────────────
router.post('/', requirePermission('admin.agents'), async (req, res) => {
  const { name, email, password, role, team, max_chats, skills, shift } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password and role are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!canAssignRole(req.user.role, role)) {
    return res.status(403).json({ error: 'Insufficient permissions to assign this role' });
  }

  // Verify role exists in roles table
  const { rows: roleCheck } = await pool.query('SELECT 1 FROM roles WHERE name=$1', [role]);
  if (!roleCheck.length) return res.status(400).json({ error: 'Role does not exist' });

  const maxChatsVal = max_chats ? Math.min(Math.max(parseInt(max_chats), 1), 100) : 10;

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, password_hash, role, team, max_chats, skills, shift)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, email, role, team, state, active_chats, max_chats, skills, shift, active, avatar_url`,
      [
        email.toLowerCase().trim(),
        name.trim(),
        hash,
        role,
        team || 'cs',
        maxChatsVal,
        skills ? skills.map(s => s.trim()).filter(Boolean) : [],
        shift || null,
      ]
    );

    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, 'agent_created', 'user', $2, $3)`,
      [req.user.id, rows[0].id, JSON.stringify({ role, email })]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/agents/me/status — agent sets own state ────────────────────────
router.patch('/me/status', async (req, res) => {
  const { state } = req.body;
  const valid = ['Available', 'Busy', 'Break', 'Offline'];
  if (!valid.includes(state)) return res.status(400).json({ error: 'Invalid state' });
  try {
    await pool.query('UPDATE users SET state=$1, updated_at=NOW() WHERE id=$2', [state, req.user.id]);
    await setAgentSession(req.user.id, { state });
    emitToSupervisors('agent_presence', { agentId: req.user.id, state });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/agents/:id — edit agent ───────────────────────────────────────
router.patch('/:id', requirePermission('admin.agents'), async (req, res) => {
  const { name, role, team, max_chats, skills, shift } = req.body;

  if (role) {
    if (!canAssignRole(req.user.role, role)) {
      return res.status(403).json({ error: 'Insufficient permissions to assign this role' });
    }
    const { rows: roleCheck } = await pool.query('SELECT 1 FROM roles WHERE name=$1', [role]);
    if (!roleCheck.length) return res.status(400).json({ error: 'Role does not exist' });
  }

  const maxChatsVal = max_chats != null
    ? Math.min(Math.max(parseInt(max_chats), 1), 100)
    : null;

  try {
    const { rows } = await pool.query(
      `UPDATE users SET
        name       = COALESCE($1, name),
        role       = COALESCE($2, role),
        team       = COALESCE($3, team),
        max_chats  = COALESCE($4, max_chats),
        skills     = COALESCE($5, skills),
        shift      = COALESCE($6, shift),
        updated_at = NOW()
       WHERE id = $7
       RETURNING id, name, email, role, team, state, active_chats, max_chats, skills, shift, active, avatar_url`,
      [
        name?.trim() || null,
        role || null,
        team || null,
        maxChatsVal,
        skills ? skills.map(s => s.trim()).filter(Boolean) : null,
        shift !== undefined ? (shift || null) : null,
        req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agent not found' });

    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, 'agent_updated', 'user', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ role, team, name })]
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/agents/:id — soft deactivate ─────────────────────────────────
router.delete('/:id', requirePermission('admin.agents'), async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }

  // Prevent deactivating last active super_admin
  const { rows: target } = await pool.query(
    `SELECT role FROM users WHERE id=$1`, [req.params.id]
  );
  if (!target.length) return res.status(404).json({ error: 'Agent not found' });

  if (target[0].role === 'super_admin') {
    const { rows: supers } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE role='super_admin' AND active=true`
    );
    if (parseInt(supers[0].cnt) <= 1) {
      return res.status(400).json({ error: 'Cannot deactivate the last super admin' });
    }
  }

  try {
    await pool.query(
      `UPDATE users SET active=false, state='Offline', updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );

    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, 'agent_deactivated', 'user', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({})]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/agents/:id/reactivate ──────────────────────────────────────────
router.post('/:id/reactivate', requirePermission('admin.agents'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET active=true, updated_at=NOW() WHERE id=$1
       RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agent not found' });

    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, 'agent_reactivated', 'user', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({})]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/agents/:id/reset-password ──────────────────────────────────────
router.post('/:id/reset-password', requirePermission('admin.agents'), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Use profile settings to change your own password' });
  }

  // Cannot reset a higher-privilege account
  const { rows: target } = await pool.query(
    `SELECT role FROM users WHERE id=$1`, [req.params.id]
  );
  if (!target.length) return res.status(404).json({ error: 'Agent not found' });
  if (target[0].role === 'super_admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`,
      [hash, req.params.id]
    );

    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
       VALUES ($1, 'password_reset', 'user', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({})]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/agents/:id/avatar ───────────────────────────────────────────────
// Admin/super_admin can update anyone; an agent can update only their own
router.post('/:id/avatar',
  (req, res, next) => {
    const isSelf = req.params.id === req.user.id;
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  },
  (req, res, next) => {
    avatarUpload.single('avatar')(req, res, (err) => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    try {
      await pool.query(
        `UPDATE users SET avatar_url=$1, updated_at=NOW() WHERE id=$2`,
        [avatarUrl, req.params.id]
      );

      await pool.query(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
         VALUES ($1, 'avatar_updated', 'user', $2, $3)`,
        [req.user.id, req.params.id, JSON.stringify({ avatar_url: avatarUrl })]
      );

      res.json({ avatar_url: avatarUrl });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/agents/:id/status ────────────────────────────────────────────────
router.get('/:id/status', async (req, res) => {
  const session = await getAgentSession(req.params.id);
  res.json(session);
});

module.exports = router;
