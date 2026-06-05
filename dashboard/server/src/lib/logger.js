'use strict';
/**
 * Structured logger for the CS Bot dashboard server.
 *
 * Uses pino which writes ndjson to stdout — Railway captures this automatically.
 * In dev (LOG_FORMAT != 'json') it uses pino-pretty for readable output.
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.info({ event: 'server_started', port: 3000 });
 *
 * Child loggers (per-module, adds a `logger` field):
 *   const log = require('./logger').child({ logger: 'routes.tickets' });
 *   log.error({ event: 'db_error', error: err.message });
 */
const pino = require('pino');

const LOG_LEVEL  = (process.env.LOG_LEVEL  || 'info').toLowerCase();
const LOG_FORMAT = (process.env.LOG_FORMAT || 'text');

let transport;
if (LOG_FORMAT !== 'json') {
  try {
    // pino-pretty is a dev dependency — gracefully skip if not installed
    transport = {
      target: 'pino-pretty',
      options: {
        colorize:      true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore:        'pid,hostname',
      },
    };
  } catch (_) {
    // fall through — use plain json
  }
}

const logger = pino({
  level: LOG_LEVEL,
  ...(transport ? { transport } : {}),
  base: null,           // omit pid and hostname from every line
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
});

module.exports = logger;
