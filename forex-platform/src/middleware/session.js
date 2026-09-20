'use strict';
const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db');
const { randomToken } = require('../lib/ids');
const { unauth, forbidden } = require('../lib/errors');

/**
 * Server-side sessions. The cookie carries an opaque random token; only its
 * SHA-256 digest is stored, so a database read cannot be replayed as a login.
 */

const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

const insertSession = db.prepare(`
  INSERT INTO sessions (token_digest, principal, subject_id, csrf_secret, ip, user_agent, expires_at)
  VALUES (?,?,?,?,?,?, datetime('now', ?))
`);
const findSession = db.prepare(`
  SELECT * FROM sessions WHERE token_digest = ? AND revoked_at IS NULL AND expires_at > datetime('now')
`);
const touchSession = db.prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`);
const revokeStmt = db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE token_digest = ? AND revoked_at IS NULL`);
const revokeAllStmt = db.prepare(
  `UPDATE sessions SET revoked_at = datetime('now') WHERE principal = ? AND subject_id = ? AND revoked_at IS NULL`
);
const revokeOneById = db.prepare(
  `UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND principal = ? AND subject_id = ?`
);

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.isProd,        // requires HTTPS in production
    sameSite: 'lax',              // blocks cross-site form posts, keeps top-level navigation working
    path: '/',
    maxAge: maxAgeMs,
  };
}

function create(res, { principal, subjectId, req }) {
  const token = randomToken(32);
  const csrfSecret = randomToken(24);
  const ttlMinutes = principal === 'admin' ? config.session.adminTtlMinutes : config.session.userTtlMinutes;
  insertSession.run(
    digest(token), principal, subjectId, csrfSecret,
    req?.clientIp || null, req?.get('user-agent')?.slice(0, 400) || null,
    `+${ttlMinutes} minutes`
  );
  const cookieName = principal === 'admin' ? config.session.adminCookieName : config.session.cookieName;
  res.cookie(cookieName, token, cookieOptions(ttlMinutes * 60 * 1000));
  // The CSRF token is deliberately readable by scripts on this origin — it is
  // the half of the double-submit pair the client echoes back in a header.
  res.cookie(config.session.csrfCookieName, csrfSecret, {
    httpOnly: false, secure: config.isProd, sameSite: 'lax', path: '/', maxAge: ttlMinutes * 60 * 1000,
  });
  return token;
}

function destroy(req, res, principal) {
  const cookieName = principal === 'admin' ? config.session.adminCookieName : config.session.cookieName;
  const token = req.cookies?.[cookieName];
  if (token) revokeStmt.run(digest(token));
  res.clearCookie(cookieName, { path: '/' });
  res.clearCookie(config.session.csrfCookieName, { path: '/' });
}

function lookup(req, principal) {
  const cookieName = principal === 'admin' ? config.session.adminCookieName : config.session.cookieName;
  const token = req.cookies?.[cookieName];
  if (!token) return null;
  const row = findSession.get(digest(token));
  if (!row || row.principal !== principal) return null;

  // Idle timeout, independent of absolute expiry.
  const idleMs = Date.now() - new Date(`${row.last_seen_at}Z`).getTime();
  if (idleMs > config.session.idleTimeoutMinutes * 60 * 1000) {
    revokeStmt.run(row.token_digest);
    return null;
  }
  touchSession.run(row.id);
  return row;
}

const revokeAll = (principal, subjectId) => revokeAllStmt.run(principal, subjectId).changes;
const revokeById = (id, principal, subjectId) => revokeOneById.run(id, principal, subjectId).changes;
const listFor = (principal, subjectId) => db.prepare(
  `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at
   FROM sessions WHERE principal = ? AND subject_id = ? ORDER BY last_seen_at DESC LIMIT 20`
).all(principal, subjectId);

/**
 * CSRF, double-submit style: the value in the non-HttpOnly cookie must be
 * echoed in the X-CSRF-Token header. A cross-origin page cannot read the
 * cookie, so it cannot forge the header.
 */
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const header = req.get('x-csrf-token');
  const session = req.session;
  if (!session) return next(unauth());
  if (!header || header !== session.csrf_secret) {
    return next(forbidden('Your session could not be verified. Refresh the page and try again.'));
  }
  return next();
}

module.exports = { create, destroy, lookup, requireCsrf, revokeAll, revokeById, listFor };
