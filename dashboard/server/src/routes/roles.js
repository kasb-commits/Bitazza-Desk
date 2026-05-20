// /api/roles — role + permission management
const router = require('express').Router();
const pool   = require('../db/pg');
const { authenticate, requirePermission } = require('../middleware/auth');

// All routes require admin.roles permission
router.use(authenticate, requirePermission('admin.roles'));

// ── Permission definitions ────────────────────────────────────────────────────
// Full catalogue — ordered for UI grouping
const ALL_PERMISSIONS = [
  // Pages
  'section.home',
  'section.inbox',
  'section.supervisor',
  'section.analytics',
  'section.metrics',
  'section.studio',
  'section.knowledge',
  'section.users',
  'section.admin',
  // User 360
  'user360.identity',
  'user360.kyc',
  'user360.restrictions',
  'user360.financials',
  'user360.tickets',
  // Inbox / conversations
  'inbox.reply',
  'inbox.assign',
  'inbox.close',
  'inbox.escalate',
  'inbox.internal_note',
  'inbox.claim',
  'inbox.set_priority',
  'inbox.set_tags',
  // Supervision
  'supervisor.whisper',
  'supervisor.reassign',
  // Bot Studio
  'studio.create',
  'studio.edit',
  'studio.delete',
  'studio.test',
  'studio.publish',
  // Administration
  'admin.agents',
  'admin.roles',
  'admin.tags',
  'admin.canned_responses',
  'admin.assignment_rules',
  'admin.sla_targets',
  'admin.bot_config',
  'admin.report_settings',
  'admin.ticket_properties',
  // Knowledge base
  'knowledge.read',
  'knowledge.write',
];

// Permissions admin role has — ceiling for admin callers
const ADMIN_PERMISSIONS = new Set([
  'section.home', 'section.inbox', 'section.supervisor', 'section.analytics', 'section.metrics',
  'section.studio', 'section.knowledge', 'section.users', 'section.admin',
  'inbox.reply', 'inbox.assign', 'inbox.close', 'inbox.escalate', 'inbox.internal_note', 'inbox.claim',
  'inbox.set_priority', 'inbox.set_tags',
  'supervisor.whisper', 'supervisor.reassign',
  'studio.create', 'studio.edit', 'studio.delete', 'studio.test', 'studio.publish',
  'admin.agents', 'admin.roles', 'admin.tags', 'admin.canned_responses', 'admin.assignment_rules',
  'admin.sla_targets', 'admin.bot_config', 'admin.report_settings', 'admin.ticket_properties',
  'knowledge.read', 'knowledge.write',
  'user360.identity', 'user360.kyc', 'user360.restrictions', 'user360.financials', 'user360.tickets',
]);

function ceilingPermissions(callerRole, requestedPerms) {
  if (callerRole === 'super_admin') return requestedPerms;
  // admin: only perms within ADMIN_PERMISSIONS
  return requestedPerms.filter(p => ADMIN_PERMISSIONS.has(p));
}

function getAllowedPermsForCaller(callerRole) {
  if (callerRole === 'super_admin') return ALL_PERMISSIONS;
  return ALL_PERMISSIONS.filter(p => ADMIN_PERMISSIONS.has(p));
}

// ── GET /api/roles — list all roles with permissions ─────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows: roles } = await pool.query(
      `SELECT name, display_name, is_preset, created_at FROM roles ORDER BY is_preset DESC, name ASC`
    );
    const { rows: perms } = await pool.query(
      `SELECT role_name, permission FROM role_permissions ORDER BY role_name, permission`
    );

    // Group permissions by role
    const permMap = {};
    for (const p of perms) {
      if (!permMap[p.role_name]) permMap[p.role_name] = [];
      permMap[p.role_name].push(p.permission);
    }

    const result = roles.map(r => ({
      ...r,
      permissions: permMap[r.name] ?? [],
    }));

    res.json({ roles: result, all_permissions: getAllowedPermsForCaller(req.user.role) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/roles — create a custom role with permissions ───────────────────
router.post('/', async (req, res) => {
  const { name, display_name, permissions = [] } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });

  const clean = name.trim().toLowerCase().replace(/\s+/g, '_');
  if (!clean) return res.status(400).json({ error: 'Invalid role name' });

  // Enforce permission ceiling
  const allowedPerms = ceilingPermissions(req.user.role, permissions);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO roles (name, display_name, is_preset, created_by)
       VALUES ($1, $2, false, $3)
       RETURNING name, display_name, is_preset, created_at`,
      [clean, display_name?.trim() || null, req.user.id]
    );

    if (allowedPerms.length) {
      const values = allowedPerms.map((p, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO role_permissions (role_name, permission) VALUES ${values}`,
        [clean, ...allowedPerms]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, metadata)
       VALUES ($1, 'role_created', 'role', $2)`,
      [req.user.id, JSON.stringify({ role_name: clean, permissions: allowedPerms })]
    );

    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], permissions: allowedPerms });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Role already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── PATCH /api/roles/:name — rename + update permissions (custom roles only) ──
router.patch('/:name', async (req, res) => {
  const { name: oldName } = req.params;
  const { name: newName, display_name, permissions } = req.body;

  const { rows: roleRows } = await pool.query(
    `SELECT name, is_preset FROM roles WHERE name = $1`, [oldName]
  );
  if (!roleRows.length) return res.status(404).json({ error: 'Role not found' });
  if (roleRows[0].is_preset) return res.status(400).json({ error: 'Cannot edit a preset role' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let currentName = oldName;

    // Rename — cascades to role_permissions and users.role via ON UPDATE CASCADE
    if (newName && newName !== oldName) {
      const clean = newName.trim().toLowerCase().replace(/\s+/g, '_');
      if (!clean) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid name' }); }
      await client.query(
        `UPDATE roles SET name = $1, display_name = COALESCE($2, display_name) WHERE name = $3`,
        [clean, display_name?.trim() ?? null, oldName]
      );
      currentName = clean;
    } else if (display_name !== undefined) {
      await client.query(
        `UPDATE roles SET display_name = $1 WHERE name = $2`,
        [display_name?.trim() || null, oldName]
      );
    }

    // Replace permissions if provided
    if (Array.isArray(permissions)) {
      const allowedPerms = ceilingPermissions(req.user.role, permissions);
      await client.query(`DELETE FROM role_permissions WHERE role_name = $1`, [currentName]);
      if (allowedPerms.length) {
        const values = allowedPerms.map((p, i) => `($1, $${i + 2})`).join(', ');
        await client.query(
          `INSERT INTO role_permissions (role_name, permission) VALUES ${values}`,
          [currentName, ...allowedPerms]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, metadata)
       VALUES ($1, 'role_updated', 'role', $2)`,
      [req.user.id, JSON.stringify({ old_name: oldName, new_name: currentName })]
    );

    await client.query('COMMIT');

    const { rows: updated } = await pool.query(
      `SELECT name, display_name, is_preset, created_at FROM roles WHERE name = $1`, [currentName]
    );
    const { rows: perms } = await pool.query(
      `SELECT permission FROM role_permissions WHERE role_name = $1`, [currentName]
    );
    res.json({ ...updated[0], permissions: perms.map(p => p.permission) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Role name already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE /api/roles/:name — delete custom role if not in use ────────────────
router.delete('/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const { rows: roleRows } = await pool.query(
      `SELECT name, is_preset FROM roles WHERE name = $1`, [name]
    );
    if (!roleRows.length) return res.status(404).json({ error: 'Role not found' });
    if (roleRows[0].is_preset) return res.status(400).json({ error: 'Cannot delete a preset role' });

    const { rows: inUse } = await pool.query(
      `SELECT 1 FROM users WHERE role = $1 AND active = true LIMIT 1`, [name]
    );
    if (inUse.length) return res.status(409).json({ error: 'Role is assigned to active agents' });

    await pool.query(`DELETE FROM roles WHERE name = $1`, [name]);

    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_type, metadata)
       VALUES ($1, 'role_deleted', 'role', $2)`,
      [req.user.id, JSON.stringify({ role_name: name })]
    );

    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
