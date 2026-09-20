'use strict';
const config = require('../config');
const rateLimit = require('../lib/ratelimit');
const { tooMany, AppError } = require('../lib/errors');

/** Resolve the client IP once, honouring the proxy setting. */
function clientIp(req, res, next) {
  req.clientIp = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  next();
}

/**
 * Route-level rate limiting. `keyBy` defaults to the client IP; auth routes
 * add the submitted identifier so one attacker cannot lock out every account
 * from a single address, and one account cannot be hammered from many.
 */
function limit({ name, max, windowMs, keyBy, message }) {
  return (req, res, next) => {
    const subject = keyBy ? keyBy(req) : req.clientIp;
    const result = rateLimit.consume(`${name}:${subject}`, max, windowMs);
    res.set('X-RateLimit-Remaining', String(result.remaining));
    if (!result.ok) {
      res.set('Retry-After', String(result.retryAfter));
      return next(tooMany(message || 'Too many requests. Please slow down and try again shortly.', result.retryAfter));
    }
    next();
  };
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found.' } });
  }
  return res.status(404).sendFile(require('path').join(config.root, 'public', '404.html'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err instanceof AppError ? err.status : 500;
  if (status >= 500) {
    // Error monitoring hook: forward to Sentry/Bugsnag/etc. here.
    console.error('[error]', err.stack || err);
  }
  if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));

  const payload = {
    error: {
      code: err.code || 'server_error',
      // Internal error text is never echoed to a client.
      message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message,
    },
  };
  if (err.details) payload.error.fields = err.details;
  if (req.path.startsWith('/api/')) return res.status(status).json(payload);
  return res.status(status).type('text/plain').send(payload.error.message);
}

module.exports = { clientIp, limit, asyncRoute, notFound, errorHandler };
