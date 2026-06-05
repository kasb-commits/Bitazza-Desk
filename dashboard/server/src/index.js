// Bitazza Help Desk — Node/Express backend
require('dotenv').config();
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const logger  = require('./lib/logger');
const requestLogger = require('./middleware/requestLogger');

// Routes
const authRouter       = require('./routes/auth');
const ticketsRouter    = require('./routes/tickets');
const agentsRouter     = require('./routes/agents');
const supervisorRouter = require('./routes/supervisor');
const copilotRouter    = require('./routes/copilot');
const cannedRouter     = require('./routes/canned');
const analyticsRouter  = require('./routes/analytics');
const metricsRouter    = require('./routes/metrics');
const insightsRouter   = require('./routes/insights');
const studioRouter     = require('./routes/studio');
const coreRouter       = require('./routes/core');
const rolesRouter          = require('./routes/roles');
const knowledgeRouter      = require('./routes/knowledge');
const usersRouter          = require('./routes/users');
const assignmentRulesRouter        = require('./routes/assignmentRules');
const notificationChannelsRouter   = require('./routes/notificationChannels');
const tagsRouter                   = require('./routes/tags');
const notificationsRouter          = require('./routes/notifications');
const ticketPropertiesRouter       = require('./routes/ticketProperties');
const uploadsRouter                = require('./routes/uploads');
const announcementsRouter          = require('./routes/announcements');
const internalRouter               = require('./routes/internal');

// Auth middleware
const { authenticate, requirePermission } = require('./middleware/auth');

// Libs
const sockets = require('./lib/sockets');
const crons   = require('./lib/crons');
const { ensureConnected } = require('./lib/redis');

const app = express();
const server = http.createServer(app);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || 'http://localhost:3002')
  .split(',').map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (curl, mobile apps, same-origin)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(requestLogger);

// Rate limit all API routes: 200 req/min per IP
app.use('/api', rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',        authRouter);
app.use('/api/tickets',     ticketsRouter);
app.use('/api/agents',      agentsRouter);
app.use('/api/supervisor',  supervisorRouter);
app.use('/api/copilot',     copilotRouter);
app.use('/api/canned-responses', cannedRouter);
app.use('/api/analytics',       analyticsRouter);
app.use('/api/metrics',         metricsRouter);
app.use('/api/insights',        insightsRouter);
app.use('/api/studio',          studioRouter);
app.use('/api/core',            coreRouter);
app.use('/api/roles',           rolesRouter);
app.use('/api/knowledge',       knowledgeRouter);
app.use('/api/users', authenticate, requirePermission('section.users'), usersRouter);
app.use('/api/assignment-rules',          assignmentRulesRouter);
app.use('/api/admin/notification-channels', notificationChannelsRouter);
app.use('/api/tags',                        tagsRouter);
app.use('/api/notifications',               notificationsRouter);
app.use('/api/ticket-properties',           ticketPropertiesRouter);
app.use('/api/uploads',                     uploadsRouter);
app.use('/api/announcements',               announcementsRouter);
app.use('/api/internal',                   internalRouter);

// Health check — must be before static/SPA fallback
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Serve uploaded avatars
app.use('/uploads', (req, res, next) => { res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); next(); }, require('express').static(require('path').join(__dirname, '..', 'uploads')));

// Serve React static files (production build)
const publicDir = require('path').join(__dirname, '..', '..', '..', 'public');
if (require('fs').existsSync(publicDir)) {
  app.use(require('express').static(publicDir));
}

// SPA fallback — serve React app for all non-API routes
const indexHtml = require('path').join(__dirname, '..', '..', '..', 'public', 'index.html');
if (require('fs').existsSync(indexHtml)) {
  app.get('*', (req, res) => res.sendFile(indexHtml));
} else {
  // 404 handler (dev mode, no static build)
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
}

// Error handler
app.use((err, req, res, _next) => {
  logger.error({
    event:      'unhandled_error',
    error:      err.message,
    stack:      err.stack,
    path:       req.path,
    method:     req.method,
    request_id: req.requestId,
  });
  res.status(500).json({ error: 'Server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || process.env.SERVER_PORT || 4000;

async function boot() {
  // Connect Redis (non-blocking — app still starts if Redis is down)
  try {
    await ensureConnected();
  } catch (err) {
    logger.warn({ event: 'redis_unavailable', error: err.message });
  }

  // Init Socket.io
  sockets.init(server);

  // Start cron jobs
  crons.start();

  server.listen(PORT, () => {
    logger.info({
      event:        'server_started',
      port:         PORT,
      frontend_url: process.env.FRONTEND_URL || 'http://localhost:3002',
      env:          process.env.RAILWAY_ENVIRONMENT || 'local',
    });
  });
}

boot();
