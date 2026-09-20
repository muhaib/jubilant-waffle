'use strict';
const { db } = require('../db');
const session = require('./session');
const { unauth, forbidden } = require('../lib/errors');

const findUser = db.prepare('SELECT * FROM users WHERE id = ?');
const findAdmin = db.prepare(`
  SELECT a.*, r.key AS role_key, r.name AS role_name
  FROM admin_users a JOIN roles r ON r.id = a.role_id WHERE a.id = ?
`);
const permsForRole = db.prepare(`
  SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = ?
`);

/** Populate req.user / req.actor when a valid user session exists. Never throws. */
function attachUser(req, res, next) {
  const row = session.lookup(req, 'user');
  if (row) {
    const user = findUser.get(row.subject_id);
    if (user) {
      req.session = row;
      req.user = user;
      req.actor = { type: 'user', id: user.id, label: user.public_id, role: 'user' };
    }
  }
  next();
}

function attachAdmin(req, res, next) {
  const row = session.lookup(req, 'admin');
  if (row) {
    const admin = findAdmin.get(row.subject_id);
    if (admin && admin.status === 'active') {
      req.session = row;
      req.admin = admin;
      req.adminPermissions = new Set(permsForRole.all(admin.role_id).map((p) => p.key));
      req.actor = { type: 'admin', id: admin.id, label: admin.public_id, role: admin.role_key };
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return next(unauth());
  next();
}

/** Statuses that may not transact. Read access is preserved deliberately. */
const BLOCKED_FROM_TRANSACTING = new Set(['restricted', 'suspended', 'banned', 'verification_required']);

function requireActiveUser(req, res, next) {
  if (!req.user) return next(unauth());
  if (!req.user.phone_verified_at) {
    return next(forbidden('Verify your phone number before using this feature.'));
  }
  if (BLOCKED_FROM_TRANSACTING.has(req.user.status)) {
    return next(forbidden(
      req.user.status === 'restricted' || req.user.status === 'suspended'
        ? 'Your account is currently restricted. Contact support for assistance.'
        : 'Your account is not able to perform this action right now.'
    ));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.admin) return next(unauth('Administrator sign-in required.'));
  next();
}

/** Server-side permission gate. Never rely on the UI hiding a control. */
function requirePermission(...keys) {
  return (req, res, next) => {
    if (!req.admin) return next(unauth('Administrator sign-in required.'));
    const has = keys.some((k) => req.adminPermissions.has(k));
    if (!has) return next(forbidden(`Your role (${req.admin.role_name}) does not include this permission.`));
    next();
  };
}

module.exports = {
  attachUser, attachAdmin, requireUser, requireActiveUser, requireAdmin, requirePermission,
  BLOCKED_FROM_TRANSACTING,
};
