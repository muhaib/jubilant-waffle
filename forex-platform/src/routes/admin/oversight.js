'use strict';
const express = require('express');
const { db } = require('../../db');
const present = require('../../lib/present');
const audit = require('../../lib/audit');
const notify = require('../../lib/notify');
const { check } = require('../../lib/validate');
const { hashPassword } = require('../../lib/password');
const { uniqueRef } = require('../../lib/ids');
const sessionMw = require('../../middleware/session');
const { requirePermission } = require('../../middleware/auth');
const { asyncRoute } = require('../../middleware/common');
const { AppError, notFound, conflict } = require('../../lib/errors');

const router = express.Router();

// ---------------------------------------------------------------------------
// Audit log — read-only for everyone, including Super Admin
// ---------------------------------------------------------------------------
router.get('/audit', requirePermission('audit.view'), asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const action = String(req.query.action || '').trim().slice(0, 60);
  const actor = String(req.query.actor || '').trim().slice(0, 40);

  const clauses = [];
  const params = {};
  if (action) { clauses.push('action LIKE @action'); params.action = `${action}%`; }
  if (actor) { clauses.push('actor_label LIKE @actor'); params.actor = `%${actor}%`; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  res.json({
    total: db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${where}`).get(params).c,
    actions: db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map((r) => r.action),
    items: db.prepare(`
      SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: limitN, offset }).map((a) => ({
      id: a.id,
      actor: a.actor_label,
      actorType: a.actor_type,
      actorRole: a.actor_role,
      action: a.action,
      entity: a.entity_type ? `${a.entity_type}${a.entity_label ? ` ${a.entity_label}` : ''}` : null,
      previous: a.previous_value,
      next: a.new_value,
      reason: a.reason,
      ip: a.ip,
      at: a.created_at,
    })),
    note: 'The audit log is append-only. It cannot be edited or deleted by any role, including Super Admin.',
  });
}));

// ---------------------------------------------------------------------------
// Risk flags
// ---------------------------------------------------------------------------
router.get('/risk-flags', requirePermission('risk.view'), asyncRoute(async (req, res) => {
  const status = ['open', 'under_review', 'confirmed', 'dismissed'].includes(req.query.status)
    ? req.query.status : null;
  const where = status ? 'WHERE rf.status = @status' : `WHERE rf.status IN ('open','under_review')`;

  res.json({
    items: db.prepare(`
      SELECT rf.*, u.public_id, u.full_name, u.status AS user_status,
             ru.public_id AS related_public_id, ru.full_name AS related_name
      FROM risk_flags rf JOIN users u ON u.id = rf.user_id
      LEFT JOIN users ru ON ru.id = rf.related_user_id
      ${where} ORDER BY rf.created_at DESC LIMIT 200
    `).all(status ? { status } : {}).map((f) => ({
      id: f.id, type: f.type, severity: f.severity, status: f.status, confidence: f.confidence,
      signals: JSON.parse(f.signals_json || '{}'),
      user: { publicId: f.public_id, fullName: f.full_name, status: f.user_status },
      relatedUser: f.related_public_id ? { publicId: f.related_public_id, fullName: f.related_name } : null,
      createdAt: f.created_at, resolvedAt: f.resolved_at, resolutionNote: f.resolution_note,
    })),
    guidance: 'Device and network signals are indicative, not conclusive. They collide legitimately (a shared handset, an office network, a public computer) and change over time. Confirm with a second signal — identity document, payment account, behaviour — before restricting an account.',
  });
}));

router.post('/risk-flags/:id/resolve', requirePermission('risk.review'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const flag = db.prepare('SELECT * FROM risk_flags WHERE id = ?').get(id);
    if (!flag) throw notFound('No such risk flag.');
    if (['confirmed', 'dismissed'].includes(flag.status)) {
      throw new AppError(400, 'already_resolved', 'This flag has already been resolved.');
    }

    const data = check(req.body)
      .enum('resolution', ['confirmed', 'dismissed', 'under_review'], { label: 'Resolution' })
      .string('note', { min: 8, max: 500, label: 'Note' })
      .done();

    db.prepare(`
      UPDATE risk_flags SET status = ?, resolved_by = ?, resolved_at = datetime('now'), resolution_note = ?
      WHERE id = ?
    `).run(data.resolution, req.admin.id, data.note, id);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(flag.user_id);

    // Dismissing the last open flag returns the account from the automatic
    // "duplicate suspected" hold to normal — an automated signal alone should
    // not leave a legitimate account marked indefinitely.
    if (data.resolution === 'dismissed' && user.status === 'duplicate_suspected') {
      const stillOpen = db.prepare(
        `SELECT COUNT(*) AS c FROM risk_flags WHERE user_id = ? AND status IN ('open','under_review') AND id <> ?`
      ).get(flag.user_id, id).c;
      if (stillOpen === 0) {
        const next = user.phone_verified_at ? 'normal' : 'verification_required';
        db.prepare(`UPDATE users SET status = ?, status_reason = NULL, updated_at = datetime('now') WHERE id = ?`)
          .run(next, user.id);
        audit.status(req, {
          entityType: 'user', entityId: user.id, from: user.status, to: next,
          note: 'Duplicate review closed with no action',
        });
      }
    }

    audit.record(req, {
      action: 'risk.flag_resolved', entityType: 'risk_flag', entityId: id, entityLabel: user.public_id,
      previous: flag.status, next: data.resolution, reason: data.note,
    });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------
router.get('/support', requirePermission('support.view'), asyncRoute(async (req, res) => {
  const status = ['open', 'pending_user', 'answered', 'closed'].includes(req.query.status)
    ? req.query.status : null;
  const where = status ? 'WHERE s.status = @status' : '';
  res.json({
    items: db.prepare(`
      SELECT s.*, u.public_id, u.full_name, u.phone_e164,
             (SELECT COUNT(*) FROM support_messages m WHERE m.request_id = s.id) AS message_count
      FROM support_requests s JOIN users u ON u.id = s.user_id
      ${where} ORDER BY
        CASE s.status WHEN 'open' THEN 0 WHEN 'pending_user' THEN 1 ELSE 2 END, s.updated_at DESC
      LIMIT 200
    `).all(status ? { status } : {}).map((s) => ({
      ref: s.ref, subject: s.subject, category: s.category, status: s.status, priority: s.priority,
      messageCount: s.message_count, createdAt: s.created_at, updatedAt: s.updated_at,
      user: { publicId: s.public_id, fullName: s.full_name },
    })),
  });
}));

router.get('/support/:ref', requirePermission('support.view'), asyncRoute(async (req, res) => {
  const row = db.prepare(`
    SELECT s.*, u.id AS uid, u.public_id, u.full_name, u.phone_e164, u.status AS user_status
    FROM support_requests s JOIN users u ON u.id = s.user_id WHERE s.ref = ?
  `).get(req.params.ref);
  if (!row) throw notFound('No such support request.');
  const phoneLib = require('../../lib/phone');
  res.json({
    request: {
      ref: row.ref, subject: row.subject, category: row.category, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
    },
    user: {
      publicId: row.public_id, fullName: row.full_name,
      phone: phoneLib.formatLocal(row.phone_e164), status: row.user_status,
    },
    messages: db.prepare(
      'SELECT author_type, author_label, body, created_at FROM support_messages WHERE request_id = ? ORDER BY created_at'
    ).all(row.id).map((m) => ({
      authorType: m.author_type, author: m.author_label, body: m.body, at: m.created_at,
    })),
  });
}));

router.post('/support/:ref/reply', requirePermission('support.respond'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const row = db.prepare('SELECT * FROM support_requests WHERE ref = ?').get(req.params.ref);
    if (!row) throw notFound('No such support request.');
    const data = check(req.body)
      .string('message', { min: 2, max: 4000, label: 'Reply' })
      .enum('status', ['answered', 'pending_user', 'closed'], { required: false, label: 'Status' })
      .done();

    db.prepare(
      'INSERT INTO support_messages (request_id, author_type, author_id, author_label, body) VALUES (?,?,?,?,?)'
    ).run(row.id, 'admin', req.admin.id, req.admin.name, data.message);
    const next = data.status || 'answered';
    db.prepare(`UPDATE support_requests SET status = ?, assigned_to = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(next, req.admin.id, row.id);

    audit.record(req, {
      action: 'support.replied', entityType: 'support', entityId: row.id, entityLabel: row.ref,
      previous: row.status, next,
    });
    notify.notify(row.user_id, {
      type: 'support.replied', severity: 'info',
      title: `Support replied to ${row.ref}`,
      body: `Our team has responded to "${row.subject}".`,
      link: `/app/#/support/${row.ref}`,
    });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Administrator accounts
// ---------------------------------------------------------------------------
router.get('/admins', requirePermission('admins.manage'), asyncRoute(async (req, res) => {
  res.json({
    roles: db.prepare(`
      SELECT r.id, r.key, r.name, r.description,
             (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
      FROM roles r ORDER BY r.id
    `).all(),
    permissionsByRole: db.prepare(`
      SELECT r.key AS role_key, p.key AS permission_key FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      ORDER BY r.id, p.key
    `).all().reduce((acc, row) => {
      (acc[row.role_key] ||= []).push(row.permission_key);
      return acc;
    }, {}),
    items: db.prepare(`
      SELECT a.id, a.public_id, a.name, a.email, a.status, a.last_login_at, a.created_at,
             a.must_change_password, r.key AS role_key, r.name AS role_name
      FROM admin_users a JOIN roles r ON r.id = a.role_id ORDER BY a.created_at
    `).all().map((a) => ({
      publicId: a.public_id, name: a.name, email: a.email, role: a.role_key, roleName: a.role_name,
      status: a.status, lastLoginAt: a.last_login_at, createdAt: a.created_at,
      mustChangePassword: Boolean(a.must_change_password),
      isSelf: a.id === req.admin.id,
    })),
  });
}));

router.post('/admins', requirePermission('admins.manage'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const data = check(req.body)
      .string('name', { min: 2, max: 120, label: 'Name' })
      .email('email')
      .string('password', { min: 12, max: 200, label: 'Temporary password' })
      .string('role', { max: 40, label: 'Role' })
      .done();

    if (db.prepare('SELECT 1 FROM admin_users WHERE email = ?').get(data.email)) {
      throw conflict('An administrator already exists with that email address.', { email: 'Already in use.' });
    }
    const role = db.prepare('SELECT * FROM roles WHERE key = ?').get(data.role);
    if (!role) {
      throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
        { role: 'Choose one of the available roles.' });
    }

    const publicId = uniqueRef('ADM', 6, (c) => !!db.prepare('SELECT 1 FROM admin_users WHERE public_id = ?').get(c));
    db.prepare(`
      INSERT INTO admin_users (public_id, name, email, password_hash, role_id, must_change_password)
      VALUES (?,?,?,?,?,1)
    `).run(publicId, data.name, data.email, hashPassword(data.password), role.id);

    audit.record(req, {
      action: 'admin.created', entityType: 'admin_user', entityLabel: publicId,
      next: { email: data.email, role: role.key },
    });
    res.status(201).json({ ok: true, publicId });
  })
);

router.post('/admins/:publicId/status', requirePermission('admins.manage'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const target = db.prepare('SELECT * FROM admin_users WHERE public_id = ?').get(req.params.publicId);
    if (!target) throw notFound('No such administrator.');
    if (target.id === req.admin.id) {
      throw new AppError(400, 'bad_request', 'You cannot disable your own administrator account.');
    }
    const data = check(req.body)
      .enum('status', ['active', 'disabled'], { label: 'Status' })
      .string('reason', { min: 4, max: 300, label: 'Reason' })
      .done();

    // The last active Super Admin cannot be disabled — that would lock
    // everyone out of role management permanently.
    if (data.status === 'disabled') {
      const superRole = db.prepare(`SELECT id FROM roles WHERE key = 'super_admin'`).get().id;
      if (target.role_id === superRole) {
        const remaining = db.prepare(
          `SELECT COUNT(*) AS c FROM admin_users WHERE role_id = ? AND status = 'active' AND id <> ?`
        ).get(superRole, target.id).c;
        if (remaining === 0) {
          throw new AppError(400, 'last_super_admin',
            'This is the only active Super Admin. Promote another administrator before disabling this one.');
        }
      }
    }

    db.prepare(`UPDATE admin_users SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(data.status, target.id);
    if (data.status === 'disabled') sessionMw.revokeAll('admin', target.id);

    audit.record(req, {
      action: 'admin.status_changed', entityType: 'admin_user', entityId: target.id, entityLabel: target.public_id,
      previous: target.status, next: data.status, reason: data.reason,
    });
    res.json({ ok: true });
  })
);

module.exports = router;
