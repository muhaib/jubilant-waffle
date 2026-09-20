'use strict';
const express = require('express');
const fs = require('fs');
const { db } = require('../db');
const present = require('../lib/present');
const notifyLib = require('../lib/notify');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const config = require('../config');
const { check } = require('../lib/validate');
const { encryptField, keyedDigest } = require('../lib/crypto');
const { uniqueRef } = require('../lib/ids');
const risk = require('../lib/risk');
const sessionMw = require('../middleware/session');
const upload = require('../middleware/upload');
const { requireUser } = require('../middleware/auth');
const { asyncRoute, limit } = require('../middleware/common');
const { AppError, notFound, forbidden, conflict } = require('../lib/errors');

const router = express.Router();
router.use(requireUser);

// ---------------------------------------------------------------------------
// Transactions — the user's own ledger
// ---------------------------------------------------------------------------
const TYPE_LABELS = {
  deposit_credit: 'Deposit credited',
  withdrawal_hold: 'Withdrawal on hold',
  withdrawal_release: 'Withdrawal hold released',
  withdrawal_settle: 'Withdrawal paid out',
  investment_allocation: 'Investment allocation',
  investment_principal_return: 'Principal returned',
  profit_credit: 'Realised profit credited',
  adjustment_credit: 'Adjustment (credit)',
  adjustment_debit: 'Adjustment (debit)',
  fee_debit: 'Fee',
};

router.get('/transactions', asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 25, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const type = typeof req.query.type === 'string' && TYPE_LABELS[req.query.type] ? req.query.type : null;

  const where = type ? 'user_id = ? AND type = ?' : 'user_id = ?';
  const params = type ? [req.user.id, type] : [req.user.id];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM transactions WHERE ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM transactions WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limitN, offset);

  res.json({
    total,
    types: Object.entries(TYPE_LABELS).map(([k, label]) => ({ key: k, label })),
    items: rows.map((t) => ({ ...present.transaction(t), label: TYPE_LABELS[t.type] || t.type })),
  });
}));

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
router.get('/notifications', asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 30, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    unread: notifyLib.unreadCount(req.user.id),
    items: notifyLib.list(req.user.id, limitN, offset).map(present.notification),
  });
}));

router.post('/notifications/read', sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  if (req.body?.id) {
    notifyLib.markRead(Number(req.body.id), req.user.id);
  } else {
    notifyLib.markAllRead(req.user.id);
  }
  res.json({ unread: notifyLib.unreadCount(req.user.id) });
}));

// ---------------------------------------------------------------------------
// Identity verification
// ---------------------------------------------------------------------------
const latestKyc = db.prepare('SELECT * FROM kyc_records WHERE user_id = ? ORDER BY id DESC LIMIT 1');

router.get('/kyc', asyncRoute(async (req, res) => {
  const row = latestKyc.get(req.user.id);
  res.json({
    required: settings.get('kyc_required', false),
    purposeNote: settings.get('kyc_purpose_note', ''),
    retentionMonths: settings.get('kyc_retention_months', 60),
    record: row && {
      status: row.status,
      masked: present.maskIdentityNumber(row.id_prefix, row.id_last),
      submittedAt: row.created_at,
      reviewedAt: row.reviewed_at,
      note: row.review_note,
      retentionUntil: row.retention_until,
      consentAt: row.consent_at,
    },
  });
}));

/**
 * Submit an identity document.
 *
 * Consent is explicit and recorded with the version of the purpose notice the
 * user actually saw. The number is encrypted at rest; only a keyed digest is
 * used for duplicate detection, and only the prefix and final digit are ever
 * returned to any dashboard.
 */
router.post('/kyc',
  limit({ name: 'kyc:submit', max: 5, windowMs: 24 * 60 * 60 * 1000, keyBy: (req) => req.user.id }),
  upload.single('front'),
  sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const existing = latestKyc.get(req.user.id);
    if (existing && ['pending', 'under_review', 'approved'].includes(existing.status)) {
      throw conflict(
        existing.status === 'approved'
          ? 'Your identity is already verified.'
          : 'You already have an identity document awaiting review.'
      );
    }

    const v = check(req.body)
      .string('cnic', { max: 20, label: 'CNIC' })
      .string('full_name_on_id', { min: 2, max: 120, label: 'Name as printed on the document' })
      .bool('consent', { mustBeTrue: true, label: 'Consent to process your identity document' });

    const digits = String(req.body?.cnic || '').replace(/\D/g, '');
    if (digits.length !== 13) v.custom('cnic', 'A CNIC is 13 digits, for example 42101-1234567-3.', false);
    v.done();

    const digest = keyedDigest(digits, config.secrets.kycDigest);
    let frontFileId = null;
    if (req.file) {
      const stored = await upload.storeUpload(req.file, { ownerUserId: req.user.id, kind: 'kyc_front' });
      frontFileId = stored.id;
    }

    const info = db.prepare(`
      INSERT INTO kyc_records (user_id, doc_type, id_ciphertext, id_digest, id_prefix, id_last,
                               full_name_on_id, front_file_id, status, consent_at, consent_version,
                               purpose_note, retention_until)
      VALUES (?, 'cnic', ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?, ?, datetime('now', ?))
    `).run(req.user.id, encryptField(digits), digest, digits.slice(0, 5), digits.slice(-1),
           req.body.full_name_on_id.trim(), frontFileId, settings.get('terms_version', '1'),
           settings.get('kyc_purpose_note', ''), `+${settings.get('kyc_retention_months', 60)} months`);

    const id = Number(info.lastInsertRowid);
    audit.record(req, {
      action: 'kyc.submitted', entityType: 'kyc', entityId: id, entityLabel: req.user.public_id,
      next: { masked: present.maskIdentityNumber(digits.slice(0, 5), digits.slice(-1)), has_image: Boolean(frontFileId) },
      reason: 'Submitted by the account holder with explicit consent',
    });
    audit.status(req, { entityType: 'kyc', entityId: id, from: null, to: 'pending' });

    if (settings.get('duplicate_review_enabled', true)) {
      risk.checkKycDuplicate(req, req.user.id, digest);
    }

    notifyLib.notify(req.user.id, {
      type: 'kyc.submitted', severity: 'info',
      title: 'Identity document submitted',
      body: 'Your document is in the review queue. We will notify you once it has been reviewed.',
      link: '/app/#/verification',
    });

    res.status(201).json({ ok: true, status: 'pending' });
  })
);

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------
const supportRefExists = db.prepare('SELECT 1 FROM support_requests WHERE ref = ?');

router.get('/support', asyncRoute(async (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM support_requests WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50'
  ).all(req.user.id);
  const whatsapp = settings.get('support_whatsapp', '');
  const phoneLib = require('../lib/phone');
  res.json({
    whatsapp: { digits: phoneLib.toWhatsappDigits(whatsapp), display: phoneLib.formatLocal(phoneLib.normalisePk(whatsapp) || whatsapp) },
    hours: settings.get('support_hours', ''),
    email: settings.get('support_email', '') || null,
    items: rows.map((r) => ({
      ref: r.ref, subject: r.subject, category: r.category, status: r.status,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  });
}));

router.get('/support/:ref', asyncRoute(async (req, res) => {
  const row = db.prepare('SELECT * FROM support_requests WHERE ref = ? AND user_id = ?')
    .get(req.params.ref, req.user.id);
  if (!row) throw notFound('No such support request.');
  res.json({
    request: {
      ref: row.ref, subject: row.subject, category: row.category, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
    },
    messages: db.prepare(
      'SELECT author_type, author_label, body, created_at FROM support_messages WHERE request_id = ? ORDER BY created_at ASC'
    ).all(row.id).map((m) => ({
      authorType: m.author_type, author: m.author_label, body: m.body, at: m.created_at,
    })),
  });
}));

const SUPPORT_CATEGORIES = ['deposit', 'withdrawal', 'verification', 'account', 'other'];

router.post('/support',
  sessionMw.requireCsrf,
  limit({ name: 'support:create', max: 5, windowMs: 60 * 60 * 1000, keyBy: (req) => req.user.id }),
  asyncRoute(async (req, res) => {
    const data = check(req.body)
      .string('subject', { min: 4, max: 140, label: 'Subject' })
      .enum('category', SUPPORT_CATEGORIES, { label: 'Category' })
      .string('message', { min: 10, max: 4000, label: 'Message' })
      .done();

    const ref = uniqueRef('SUP', 6, (c) => !!supportRefExists.get(c));
    const info = db.prepare(
      'INSERT INTO support_requests (ref, user_id, category, subject) VALUES (?,?,?,?)'
    ).run(ref, req.user.id, data.category, data.subject);
    const id = Number(info.lastInsertRowid);
    db.prepare(
      'INSERT INTO support_messages (request_id, author_type, author_id, author_label, body) VALUES (?, ?, ?, ?, ?)'
    ).run(id, 'user', req.user.id, req.user.public_id, data.message);

    audit.record(req, { action: 'support.opened', entityType: 'support', entityId: id, entityLabel: ref });
    audit.status(req, { entityType: 'support', entityId: id, from: null, to: 'open' });
    res.status(201).json({ ref });
  })
);

router.post('/support/:ref/reply', sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  const row = db.prepare('SELECT * FROM support_requests WHERE ref = ? AND user_id = ?')
    .get(req.params.ref, req.user.id);
  if (!row) throw notFound('No such support request.');
  if (row.status === 'closed') throw new AppError(400, 'closed', 'This request is closed. Open a new one to continue.');
  const data = check(req.body).string('message', { min: 2, max: 4000, label: 'Message' }).done();
  db.prepare(
    'INSERT INTO support_messages (request_id, author_type, author_id, author_label, body) VALUES (?, ?, ?, ?, ?)'
  ).run(row.id, 'user', req.user.id, req.user.public_id, data.message);
  db.prepare(`UPDATE support_requests SET status = 'open', updated_at = datetime('now') WHERE id = ?`).run(row.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Access-controlled file delivery
// ---------------------------------------------------------------------------
const fileStmt = db.prepare('SELECT * FROM files WHERE id = ?');

/**
 * Uploaded files live outside the web root and are only ever streamed through
 * here. A user may read their own files; an admin needs the matching view
 * permission, and every administrative read of an identity image is audited.
 */
function serveFile(req, res, { isAdmin }) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw notFound('No such file.');
  const file = fileStmt.get(id);
  if (!file) throw notFound('No such file.');

  if (!isAdmin && file.owner_user_id !== req.user.id) {
    // Same response as a missing file: a probe cannot learn that an id exists.
    throw notFound('No such file.');
  }
  const absolute = upload.absolutePathFor(file.stored_name);
  if (!absolute || !fs.existsSync(absolute)) throw notFound('That file is no longer available.');

  res.set({
    'Content-Type': file.mime,
    'Content-Length': String(file.size_bytes),
    'Content-Disposition': `inline; filename="evidence-${id}${file.mime === 'image/png' ? '.png' : '.jpg'}"`,
    // Never let a browser guess a different type for user-supplied bytes.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
    'Cache-Control': 'private, max-age=0, no-store',
  });
  fs.createReadStream(absolute).pipe(res);
}

router.get('/files/:id', asyncRoute(async (req, res) => serveFile(req, res, { isAdmin: false })));

module.exports = { router, serveFile };
