'use strict';
/**
 * Express request logging middleware.
 *
 * Generates (or accepts forwarded) X-Request-ID, logs request_start and
 * request_complete with latency, and adds the ID to the response header.
 * agent_id is populated after authenticate() middleware runs — null for
 * public routes since req.user isn't set yet.
 */
const { randomUUID } = require('crypto');
const logger = require('../lib/logger').child({ logger: 'access' });

function requestLogger(req, res, next) {
  const reqId = req.headers['x-request-id'] || randomUUID();
  req.requestId = reqId;
  res.setHeader('X-Request-ID', reqId);

  const t0 = Date.now();

  logger.info({
    event:      'request_start',
    method:     req.method,
    path:       req.path,
    request_id: reqId,
  });

  res.on('finish', () => {
    const latencyMs = Date.now() - t0;
    const agentId   = req.user ? req.user.id : null;
    const level     = res.statusCode >= 400 ? 'warn' : 'info';

    logger[level]({
      event:      'request_complete',
      method:     req.method,
      path:       req.path,
      status:     res.statusCode,
      latency_ms: latencyMs,
      request_id: reqId,
      agent_id:   agentId,
    });
  });

  next();
}

module.exports = requestLogger;
