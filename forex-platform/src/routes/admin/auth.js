'use strict';
const express = require('express');
const { db } = require('../../db');
const { check } = require('../../lib/validate');
const { hashPassword, verifyPassword, passwordProblems } = require('../../lib/password');
const audit = require('../../lib/audit');
const sessionMw = require('../../middleware/session');
const { requireAdmin } = require('../../middleware/auth');
const { asyncRoute, limit } = require('../../middleware/common');
const { AppError, unauth } = require('../../lib/errors');

const router = express.Router();

const byEmail = db.prepare(`
  SELECT a.*, r.key AS role_key, r.name AS role_name FROM admin_users a
  JOIN roles r ON r.id = a.role_id WHERE a.email = ?
`);
const permsFor = db.prepare(`
  SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?
`);

const LOCKOUT_THRESHOLD = 4;
const LOCKOUT_MINUTES = 30;

function adminDto(admin, permissions) {
  return {
    publicId: admin.public_id,
    name: admin.name,
    email: admin.email,
    role: admin.role_key,
    roleName: admin.role_name,
    permissions: [...permissions],
    mustChangePassword: Boolean(admin.must_change_password),
    lastLoginAt: admin.last_login_at,
  };
}

router.post('/login',
  limit({ name: 'adminlogin:ip', max: 10, windowMs: 15 * 60 * 1000,
    message: 'Too many sign-in attempts from this network.' }),
  limit({ name: 'adminlogin:id', max: 5, windowMs: 15 * 60 * 1000,
    keyBy: (req) => String(req.body?.email || '').toLowerCase().slice(0, 80) }),
  asyncRoute(async (req, res) => {
    const data = check(req.body)
      .email('email')
      .string('password', { max: 200, label: 'Password' })
      .done();

    const admin = byEmail.get(data.email);
    const generic = unauth('Those sign-in details are not correct.');
    if (!admin) { verifyPassword(data.password, null); throw generic; }
    if (admin.status !== 'active') throw generic;
    if (admin.locked_until && db.prepare(`SELECT datetime('now') < ? AS l`).get(admin.locked_until).l === 1) {
      throw new AppError(429, 'account_locked', 'This administrator account is temporarily locked.');
    }
    if (!verifyPassword(data.password, admin.password_hash)) {
      const failures = admin.failed_logins + 1;
      if (failures >= LOCKOUT_THRESHOLD) {
        db.prepare(`UPDATE admin_users SET failed_logins = ?, locked_until = datetime('now', ?) WHERE id = ?`)
          .run(failures, `+${LOCKOUT_MINUTES} minutes`, admin.id);
        audit.record(req, {
          action: 'admin.locked_out', entityType: 'admin_user', entityId: admin.id, entityLabel: admin.public_id,
          reason: `${failures} consecutive failed sign-in attempts`,
          actor: { type: 'system', id: null, label: 'admin-auth' },
        });
      } else {
        db.prepare('UPDATE admin_users SET failed_logins = ? WHERE id = ?').run(failures, admin.id);
      }
      throw generic;
    }

    db.prepare(`UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`)
      .run(admin.id);
    req.actor = { type: 'admin', id: admin.id, label: admin.public_id, role: admin.role_key };
    sessionMw.create(res, { principal: 'admin', subjectId: admin.id, req });
    audit.record(req, { action: 'admin.login', entityType: 'admin_user', entityId: admin.id, entityLabel: admin.public_id });

    const permissions = new Set(permsFor.all(admin.role_id).map((p) => p.key));
    res.json({ admin: adminDto(admin, permissions) });
  })
);

router.post('/logout', asyncRoute(async (req, res) => {
  if (req.admin) {
    audit.record(req, { action: 'admin.logout', entityType: 'admin_user', entityId: req.admin.id, entityLabel: req.admin.public_id });
  }
  sessionMw.destroy(req, res, 'admin');
  res.json({ ok: true });
}));

router.get('/session', (req, res) => {
  if (!req.admin) return res.json({ authenticated: false });
  res.json({ authenticated: true, admin: adminDto(req.admin, req.adminPermissions) });
});

router.post('/password', requireAdmin, sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  const v = check(req.body)
    .string('current_password', { max: 200, label: 'Current password' })
    .string('new_password', { min: 12, max: 200, label: 'New password' })
    .string('confirm_password', { max: 200, label: 'Password confirmation' });
  const problems = passwordProblems(req.body?.new_password);
  if (problems.length) v.custom('new_password', problems.join(' '), false);
  if (String(req.body?.new_password || '').length < 12) {
    v.custom('new_password', 'Administrator passwords must be at least 12 characters.', false);
  }
  if (req.body?.new_password !== req.body?.confirm_password) {
    v.custom('confirm_password', 'The two passwords do not match.', false);
  }
  const data = v.done();

  if (!verifyPassword(data.current_password, req.admin.password_hash)) {
    throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
      { current_password: 'That is not your current password.' });
  }
  db.prepare(`UPDATE admin_users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`)
    .run(hashPassword(data.new_password), req.admin.id);
  sessionMw.revokeAll('admin', req.admin.id);
  sessionMw.create(res, { principal: 'admin', subjectId: req.admin.id, req });
  audit.record(req, {
    action: 'admin.password_changed', entityType: 'admin_user', entityId: req.admin.id, entityLabel: req.admin.public_id,
  });
  res.json({ ok: true });
}));

module.exports = { router, adminDto };
