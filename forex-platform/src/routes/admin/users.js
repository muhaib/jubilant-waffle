'use strict';
const express = require('express');
const { db, tx } = require('../../db');
const present = require('../../lib/present');
const ledger = require('../../lib/ledger');
const audit = require('../../lib/audit');
const notify = require('../../lib/notify');
const money = require('../../lib/money');
const { check } = require('../../lib/validate');
const { decryptField } = require('../../lib/crypto');
const sessionMw = require('../../middleware/session');
const { requirePermission } = require('../../middleware/auth');
const { asyncRoute } = require('../../middleware/common');
const { AppError, notFound, bad } = require('../../lib/errors');

const router = express.Router();

const USER_STATUSES = ['normal', 'verification_required', 'duplicate_suspected', 'under_review', 'restricted', 'suspended', 'banned'];

// ---------------------------------------------------------------------------
// Search / list
// ---------------------------------------------------------------------------
router.get('/users', requirePermission('users.view'), asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 25, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = String(req.query.q || '').trim().slice(0, 80);
  const status = USER_STATUSES.includes(req.query.status) ? req.query.status : null;

  const clauses = [];
  const params = {};
  if (q) {
    // Parameterised throughout; `q` is never interpolated into the SQL text.
    clauses.push('(u.public_id LIKE @q OR u.full_name LIKE @q OR u.email_normalized LIKE @q OR u.phone_e164 LIKE @q)');
    params.q = `%${q}%`;
  }
  if (status) { clauses.push('u.status = @status'); params.status = status; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM users u ${where}`).get(params).c;
  const rows = db.prepare(`
    SELECT u.*, b.available_cents, b.invested_cents,
           (SELECT COUNT(*) FROM risk_flags rf WHERE rf.user_id = u.id AND rf.status IN ('open','under_review')) AS open_flags,
           (SELECT COUNT(*) FROM deposits d WHERE d.user_id = u.id AND d.status IN ('pending','under_review')) AS pending_deposits
    FROM users u LEFT JOIN v_user_balances b ON b.user_id = u.id
    ${where} ORDER BY u.created_at DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: limitN, offset });

  res.json({
    total,
    statuses: USER_STATUSES,
    items: rows.map((u) => ({
      ...present.userForAdmin(u),
      availableCents: u.available_cents || 0,
      investedCents: u.invested_cents || 0,
      openFlags: u.open_flags,
      pendingDeposits: u.pending_deposits,
    })),
  });
}));

// ---------------------------------------------------------------------------
// Single user profile
// ---------------------------------------------------------------------------
const userByPublicId = db.prepare('SELECT * FROM users WHERE public_id = ?');

function loadUser(publicId) {
  const u = userByPublicId.get(publicId);
  if (!u) throw notFound('No such user.');
  return u;
}

router.get('/users/:publicId', requirePermission('users.view'), asyncRoute(async (req, res) => {
  const user = loadUser(req.params.publicId);
  const profile = db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(user.id) || {};
  const kyc = db.prepare('SELECT * FROM kyc_records WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
  const canSeeKyc = req.adminPermissions.has('kyc.view');

  res.json({
    user: present.userForAdmin(user),
    profile: {
      dateOfBirth: profile.date_of_birth, addressLine: profile.address_line,
      city: profile.city, country: profile.country, occupation: profile.occupation,
    },
    balances: ledger.balancesFor(user.id),
    kyc: kyc && canSeeKyc ? {
      id: kyc.id,
      status: kyc.status,
      // Masked by default. The full number requires kyc.reveal and is audited.
      masked: present.maskIdentityNumber(kyc.id_prefix, kyc.id_last),
      nameOnId: kyc.full_name_on_id,
      imageUrl: kyc.front_file_id ? `/api/admin/files/${kyc.front_file_id}` : null,
      submittedAt: kyc.created_at,
      reviewedAt: kyc.reviewed_at,
      note: kyc.review_note,
      consentAt: kyc.consent_at,
      retentionUntil: kyc.retention_until,
      canReveal: req.adminPermissions.has('kyc.reveal'),
    } : null,
    deposits: db.prepare(`
      SELECT d.*, pm.name AS method_name FROM deposits d JOIN payment_methods pm ON pm.id = d.method_id
      WHERE d.user_id = ? ORDER BY d.created_at DESC LIMIT 20
    `).all(user.id).map((d) => present.deposit(d)),
    withdrawals: db.prepare(`
      SELECT w.*, pm.name AS method_name FROM withdrawals w JOIN payment_methods pm ON pm.id = w.method_id
      WHERE w.user_id = ? ORDER BY w.created_at DESC LIMIT 20
    `).all(user.id).map((w) => present.withdrawal(w)),
    investments: db.prepare('SELECT * FROM investments WHERE user_id = ? ORDER BY opened_at DESC LIMIT 20')
      .all(user.id).map(present.investment),
    transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30')
      .all(user.id).map(present.transaction),
    riskFlags: req.adminPermissions.has('risk.view') ? db.prepare(`
      SELECT rf.*, ru.public_id AS related_public_id FROM risk_flags rf
      LEFT JOIN users ru ON ru.id = rf.related_user_id
      WHERE rf.user_id = ? ORDER BY rf.created_at DESC
    `).all(user.id).map((f) => ({
      id: f.id, type: f.type, severity: f.severity, status: f.status, confidence: f.confidence,
      signals: JSON.parse(f.signals_json || '{}'), relatedUser: f.related_public_id,
      createdAt: f.created_at, resolvedAt: f.resolved_at, resolutionNote: f.resolution_note,
    })) : [],
    devices: db.prepare(`
      SELECT device_hash, user_agent, platform, timezone, first_seen_at, last_seen_at, seen_count, last_seen_ip,
        (SELECT COUNT(*) FROM devices d2 WHERE d2.device_hash = devices.device_hash) AS accounts_on_device
      FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 10
    `).all(user.id).map((d) => ({
      hash: `${d.device_hash.slice(0, 12)}…`,
      userAgent: d.user_agent, platform: d.platform, timezone: d.timezone,
      firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at, seenCount: d.seen_count,
      lastSeenIp: d.last_seen_ip, accountsOnDevice: d.accounts_on_device,
    })),
    notes: db.prepare(`
      SELECT n.body, n.created_at, a.name AS admin_name, a.public_id AS admin_public_id
      FROM admin_notes n JOIN admin_users a ON a.id = n.admin_id
      WHERE n.user_id = ? ORDER BY n.created_at DESC
    `).all(user.id).map((n) => ({ body: n.body, at: n.created_at, admin: n.admin_name, adminId: n.admin_public_id })),
    statusHistory: audit.historyFor('user', user.id).map(present.statusEvent),
  });
}));

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------
const ACTIONABLE = {
  restrict: { status: 'restricted', verb: 'restricted' },
  suspend: { status: 'suspended', verb: 'suspended' },
  ban: { status: 'banned', verb: 'banned' },
  review: { status: 'under_review', verb: 'placed under review' },
  restore: { status: 'normal', verb: 'restored' },
};

router.post('/users/:publicId/status', requirePermission('users.manage'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const user = loadUser(req.params.publicId);
    const data = check(req.body)
      .enum('action', Object.keys(ACTIONABLE), { label: 'Action' })
      .string('reason', { min: 8, max: 500, label: 'Reason' })
      .done();

    const target = ACTIONABLE[data.action];
    if (user.status === target.status) {
      throw bad(`This account is already ${target.verb}.`);
    }
    // Restoring a never-verified account returns it to the verification gate,
    // not to full access.
    const nextStatus = target.status === 'normal' && !user.phone_verified_at
      ? 'verification_required' : target.status;

    db.prepare(`UPDATE users SET status = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(nextStatus, data.reason, user.id);

    if (['suspended', 'banned'].includes(nextStatus)) {
      sessionMw.revokeAll('user', user.id);
    }

    audit.record(req, {
      action: 'user.status_changed', entityType: 'user', entityId: user.id, entityLabel: user.public_id,
      previous: user.status, next: nextStatus, reason: data.reason,
    });
    audit.status(req, {
      entityType: 'user', entityId: user.id, from: user.status, to: nextStatus, note: data.reason,
    });
    notify.notify(user.id, {
      type: 'account.status_changed',
      severity: nextStatus === 'normal' ? 'success' : 'critical',
      title: nextStatus === 'normal' ? 'Your account has been restored' : `Your account has been ${target.verb}`,
      body: nextStatus === 'normal'
        ? 'Your account is active again. Contact support if you have any questions.'
        : `Reason: ${data.reason}. Contact support if you believe this is a mistake.`,
      link: '/app/#/support',
    });

    res.json({ ok: true, status: nextStatus });
  })
);

router.post('/users/:publicId/notes', requirePermission('users.notes'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const user = loadUser(req.params.publicId);
    const data = check(req.body).string('body', { min: 2, max: 2000, label: 'Note' }).done();
    db.prepare('INSERT INTO admin_notes (user_id, admin_id, body) VALUES (?,?,?)')
      .run(user.id, req.admin.id, data.body);
    audit.record(req, {
      action: 'user.note_added', entityType: 'user', entityId: user.id, entityLabel: user.public_id,
    });
    res.status(201).json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Identity document reveal — separately permissioned and individually audited
// ---------------------------------------------------------------------------
router.post('/users/:publicId/kyc/reveal', requirePermission('kyc.reveal'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const user = loadUser(req.params.publicId);
    const data = check(req.body).string('reason', { min: 8, max: 300, label: 'Reason' }).done();
    const kyc = db.prepare('SELECT * FROM kyc_records WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
    if (!kyc) throw notFound('No identity document on file for this account.');

    audit.record(req, {
      action: 'kyc.revealed', entityType: 'kyc', entityId: kyc.id, entityLabel: user.public_id,
      reason: data.reason,
      next: { masked: present.maskIdentityNumber(kyc.id_prefix, kyc.id_last) },
    });

    let plaintext;
    try {
      plaintext = decryptField(kyc.id_ciphertext);
    } catch {
      throw new AppError(500, 'decrypt_failed',
        'The stored document could not be decrypted. The field encryption key may have changed.');
    }
    const formatted = `${plaintext.slice(0, 5)}-${plaintext.slice(5, 12)}-${plaintext.slice(12)}`;
    res.json({ value: formatted, revealedAt: new Date().toISOString(), audited: true });
  })
);

router.post('/users/:publicId/kyc/review', requirePermission('kyc.review'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const user = loadUser(req.params.publicId);
    const data = check(req.body)
      .enum('decision', ['approved', 'rejected', 'under_review'], { label: 'Decision' })
      .string('note', { required: false, max: 500, label: 'Note' })
      .done();
    const kyc = db.prepare('SELECT * FROM kyc_records WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
    if (!kyc) throw notFound('No identity document on file for this account.');
    if (data.decision === 'rejected' && !data.note) {
      throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
        { note: 'Give the user a reason for the rejection.' });
    }

    db.prepare(`
      UPDATE kyc_records SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'),
        review_note = ?, updated_at = datetime('now') WHERE id = ?
    `).run(data.decision, req.admin.id, data.note, kyc.id);

    audit.record(req, {
      action: 'kyc.reviewed', entityType: 'kyc', entityId: kyc.id, entityLabel: user.public_id,
      previous: kyc.status, next: data.decision, reason: data.note,
    });
    audit.status(req, { entityType: 'kyc', entityId: kyc.id, from: kyc.status, to: data.decision, note: data.note });
    notify.notify(user.id, {
      type: 'kyc.reviewed',
      severity: data.decision === 'approved' ? 'success' : data.decision === 'rejected' ? 'warning' : 'info',
      title: data.decision === 'approved' ? 'Identity verified'
        : data.decision === 'rejected' ? 'Identity document rejected' : 'Identity document under review',
      body: data.note || 'Your identity document has been reviewed.',
      link: '/app/#/verification',
    });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Manual balance adjustment — permanent, reasoned, fully audited
// ---------------------------------------------------------------------------
router.post('/users/:publicId/adjust', requirePermission('ledger.adjust'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const user = loadUser(req.params.publicId);
    const v = check(req.body)
      .enum('type', ['adjustment_credit', 'adjustment_debit', 'profit_credit'], { label: 'Adjustment type' })
      .string('amount', { max: 20, label: 'Amount' })
      .string('reason', { min: 12, max: 500, label: 'Reason' });
    const cents = money.parseToCents(req.body?.amount);
    if (cents === null || cents <= 0) v.custom('amount', 'Enter a positive amount such as 50 or 1,200.75.', false);
    const data = v.done();

    const before = ledger.balancesFor(user.id);
    const direction = data.type === 'adjustment_debit' ? 'debit' : 'credit';
    if (direction === 'debit' && cents > before.availableCents) {
      throw new AppError(422, 'insufficient_funds',
        `That account has ${money.formatCents(before.availableCents, { withSymbol: true })} available.`,
        { amount: 'The debit exceeds the available balance.' });
    }

    // The audit record is written first so the ledger row can point at it.
    const auditId = audit.record(req, {
      action: 'ledger.adjusted', entityType: 'user', entityId: user.id, entityLabel: user.public_id,
      previous: { available_cents: before.availableCents, realized_profit_cents: before.realizedProfitCents },
      next: { type: data.type, amount_cents: cents, direction },
      reason: data.reason,
    });

    const posted = tx(() => ledger.post({
      userId: user.id, type: data.type, direction, bucket: 'available', amountCents: cents,
      source: 'admin', auditLogId: auditId,
      memo: `${data.reason} — posted by ${req.admin.public_id}`,
    }))();

    const after = ledger.balancesFor(user.id);
    notify.notify(user.id, {
      type: 'balance.adjusted',
      severity: direction === 'credit' ? 'success' : 'warning',
      title: data.type === 'profit_credit'
        ? `Realised profit of ${money.formatCents(cents, { withSymbol: true })} credited`
        : `Balance ${direction === 'credit' ? 'credited' : 'debited'} by ${money.formatCents(cents, { withSymbol: true })}`,
      body: `${data.reason} Reference ${posted.txnRef}.`,
      link: '/app/#/transactions',
    });

    res.json({
      ok: true,
      transaction: posted.txnRef,
      before: { availableCents: before.availableCents },
      after: { availableCents: after.availableCents },
    });
  })
);

module.exports = router;
