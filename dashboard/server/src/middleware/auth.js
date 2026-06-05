// JWT auth middleware + RBAC helpers
const jwt    = require('jsonwebtoken');
const pool   = require('../db/pg');
const logger = require('../lib/logger').child({ logger: 'auth' });
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// Attach decoded user to req.user; reject if missing/invalid
function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    logger.warn({ event: 'auth_missing_token', path: req.path, ip: req.ip });
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    logger.warn({ event: 'auth_invalid_token', path: req.path, ip: req.ip, error: err.message });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Role-based guard — kept for backwards compat on agent/supervisor listing routes
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.flat().includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Permission-based guard — checks req.user.permissions[] embedded in JWT
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    const perms = req.user.permissions ?? [];
    if (!perms.includes(permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Fetch permissions for a role from DB
async function getPermissionsForRole(roleName) {
  const { rows } = await pool.query(
    'SELECT permission FROM role_permissions WHERE role_name = $1',
    [roleName]
  );
  return rows.map(r => r.permission);
}

// Sign JWT — embeds permissions[] so every request is stateless
async function signToken(user) {
  const permissions = await getPermissionsForRole(user.role);
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url ?? null,  // added so req.user.avatar_url is available on every request
      role: user.role,
      team: user.team,
      permissions,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = { authenticate, requireRole, requirePermission, signToken, getPermissionsForRole };
