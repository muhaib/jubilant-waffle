'use strict';
const express = require('express');
const { db, tx } = require('../db');
const { check } = require('../lib/validate');
const { uniqueRef } = require('../lib/ids');
const money = require('../lib/money');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const settings = require('../lib/settings');
const present = require('../lib/present');
const sessionMw = require('../middleware/session');
const upload = require('../middleware/upload');
const { requireUser, requireActiveUser } = require('../middleware/auth');
const { asyncRoute, limit } = require('../middleware/common');
const { AppError, notFound, bad } = require('../lib/errors');

const router = express.Router();
router.use(requireUser);

const methodsStmt = db.prepare(`
  SELECT id, key, name, provider, account_title, account_number, instructions, sort_order
  FROM payment_methods WHERE is_active = 1 AND for_deposit = 1 ORDER BY sort_order, name
`);
const methodById = db.prepare('SELECT * FROM payment_methods WHERE id = ? AND is_active = 1 AND for_deposit = 1');
const refExists = db.prepare('SELECT 1 FROM deposits WHERE ref = ?');

const listStmt = db.prepare(`
  SELECT d.*, pm.name AS method_name, pm.key AS method_key,
         (SELECT COUNT(*) FROM deposit_evidence de WHERE de.deposit_id = d.id) AS evidence_count
  FROM deposits d JOIN payment_methods pm ON pm.id = d.method_id
  WHERE d.user_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?
`);
const countStmt = db.prepare('SELECT COUNT(*) AS c FROM deposits WHERE user_id = ?');
const oneStmt = db.prepare(`
  SELECT d.*, pm.name AS method_name, pm.key AS method_key,
         (SELECT COUNT(*) FROM deposit_evidence de WHERE de.deposit_id = d.id) AS evidence_count
  FROM deposits d JOIN payment_methods pm ON pm.id = d.method_id
  WHERE d.ref = ? AND d.user_id = ?
`);
const evidenceStmt = db.prepare(`
  SELECT f.id, f.original_name, f.mime, f.size_bytes, f.created_at
  FROM deposit_evidence de JOIN files f ON f.id = de.file_id WHERE de.deposit_id = ?
`);
const duplicateRefStmt = db.prepare(`
  SELECT ref FROM deposits WHERE provider_txn_ref = ? AND status <> 'rejected' AND status <> 'cancelled'
`);

/** Where to send the money, and exactly what to do — all admin-configured. */
router.get('/methods', asyncRoute(async (req, res) => {
  res.json({
    enabled: settings.get('deposits_enabled', true),
    instructions: settings.get('deposit_instructions', ''),
    reviewSlaHours: settings.get('deposit_review_sla_hours', 24),
    limits: settings.investmentLimits(),
    methods: methodsStmt.all().map((m) => ({
      id: m.id,
      key: m.key,
      name: m.name,
      provider: m.provider,
      accountTitle: m.account_title || null,
      accountNumber: m.account_number || null,
      instructions: m.instructions || null,
      // A method with no receiving account configured cannot be selected.
      ready: Boolean(m.account_number),
    })),
  });
}));

router.get('/', asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    total: countStmt.get(req.user.id).c,
    items: listStmt.all(req.user.id, limitN, offset).map((d) => present.deposit(d)),
  });
}));

router.get('/:ref', asyncRoute(async (req, res) => {
  const row = oneStmt.get(req.params.ref, req.user.id);
  if (!row) throw notFound('No such deposit.');
  res.json({
    deposit: present.deposit(row),
    evidence: evidenceStmt.all(row.id).map((f) => ({
      id: f.id, name: f.original_name, mime: f.mime, sizeBytes: f.size_bytes,
      url: `/api/files/${f.id}`, uploadedAt: f.created_at,
    })),
    history: audit.historyFor('deposit', row.id).map(present.statusEvent),
  });
}));

/**
 * Submit a deposit for verification.
 *
 * This records a CLAIM that a payment was made. It credits nothing. The
 * balance moves only when a member of staff with the deposits.review
 * permission verifies it against the receiving account records.
 */
router.post('/',
  requireActiveUser,
  limit({ name: 'deposit:create', max: 10, windowMs: 60 * 60 * 1000, keyBy: (req) => req.user.id,
    message: 'You have submitted several deposits in the last hour. Contact support if you need to add more.' }),
  // CSRF is checked before the multipart body is read, so a forged
  // cross-site post is rejected without the server parsing an upload.
  sessionMw.requireCsrf,
  upload.single('screenshot'),
  asyncRoute(async (req, res) => {
    if (!settings.get('deposits_enabled', true)) {
      throw new AppError(503, 'deposits_closed', 'Deposits are temporarily unavailable. Please try again later.');
    }

    const v = check(req.body)
      .string('amount', { max: 20, label: 'Deposit amount' })
      .int('method_id', { label: 'Payment method' })
      .string('sender_account', { max: 40, label: 'Sending account number' })
      .string('sender_name', { required: false, max: 120, label: 'Sender name' })
      .string('provider_txn_ref', { min: 4, max: 60, label: 'Transaction ID' })
      .isoDate('paid_at', { label: 'Payment date and time', notFuture: true })
      .string('user_note', { required: false, max: 500, label: 'Note' });

    const limits = settings.investmentLimits();
    const cents = money.parseToCents(req.body?.amount);
    if (cents === null) {
      v.custom('amount', 'Enter an amount such as 250 or 1,000.50.', false);
    } else {
      if (cents < limits.minCents) {
        v.custom('amount', `The minimum deposit is ${money.formatCents(limits.minCents, { withSymbol: true })}.`, false);
      }
      if (cents > limits.maxCents) {
        v.custom('amount', `The maximum deposit is ${money.formatCents(limits.maxCents, { withSymbol: true })}.`, false);
      }
    }

    const method = methodById.get(Number(req.body?.method_id));
    if (!method) v.custom('method_id', 'Choose one of the available payment methods.', false);
    else if (!method.account_number) {
      v.custom('method_id', 'That payment method is not currently accepting deposits.', false);
    }
    if (!req.file) v.custom('screenshot', 'Attach a screenshot of the payment confirmation.', false);

    const data = v.done();

    // A transaction reference is unique per real payment. Reusing one is
    // either a mistake or an attempt to claim the same payment twice.
    const dup = duplicateRefStmt.get(data.provider_txn_ref);
    if (dup) {
      throw new AppError(409, 'duplicate_reference',
        'That transaction ID has already been submitted. Check the reference, or contact support if you believe this is an error.',
        { provider_txn_ref: `Already submitted on deposit ${dup.ref}.` });
    }

    const stored = await upload.storeUpload(req.file, { ownerUserId: req.user.id, kind: 'deposit_evidence' });
    const ref = uniqueRef('DEP', 8, (c) => !!refExists.get(c));

    const depositId = tx(() => {
      const info = db.prepare(`
        INSERT INTO deposits (ref, user_id, amount_cents, method_id, sender_name, sender_account,
                              provider_txn_ref, paid_at, user_note, status, submitted_ip)
        VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)
      `).run(ref, req.user.id, cents, method.id, data.sender_name, data.sender_account,
             data.provider_txn_ref, data.paid_at, data.user_note, req.clientIp || null);
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO deposit_evidence (deposit_id, file_id) VALUES (?,?)').run(id, stored.id);
      return id;
    })();

    audit.record(req, {
      action: 'deposit.submitted', entityType: 'deposit', entityId: depositId, entityLabel: ref,
      next: { amount_cents: cents, method: method.key, provider_txn_ref: data.provider_txn_ref },
    });
    audit.status(req, {
      entityType: 'deposit', entityId: depositId, from: null, to: 'pending',
      note: 'Submitted by the account holder with payment evidence attached',
    });
    notify.notify(req.user.id, {
      type: 'deposit.submitted', severity: 'info',
      title: `Deposit ${ref} received for verification`,
      body: `We have received your submission for ${money.formatCents(cents, { withSymbol: true })}. It will be credited once our team verifies the payment against our receiving account. A screenshot on its own does not credit your balance.`,
      link: `/app/#/deposits/${ref}`,
      smsText: `Deposit ${ref} received for verification. You will be notified once it is reviewed.`,
    });

    res.status(201).json({
      deposit: present.deposit(oneStmt.get(ref, req.user.id)),
      message: 'Submitted for verification.',
    });
  })
);

router.post('/:ref/cancel', sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  const row = oneStmt.get(req.params.ref, req.user.id);
  if (!row) throw notFound('No such deposit.');
  if (!['pending', 'info_requested'].includes(row.status)) {
    throw bad(`A deposit that is ${row.status.replace('_', ' ')} can no longer be cancelled. Contact support if you need help.`);
  }
  db.prepare(`UPDATE deposits SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(row.id);
  audit.record(req, {
    action: 'deposit.cancelled', entityType: 'deposit', entityId: row.id, entityLabel: row.ref,
    previous: row.status, next: 'cancelled', reason: 'Cancelled by the account holder',
  });
  audit.status(req, {
    entityType: 'deposit', entityId: row.id, from: row.status, to: 'cancelled',
    note: 'Cancelled by the account holder',
  });
  res.json({ ok: true, deposit: present.deposit(oneStmt.get(row.ref, req.user.id)) });
}));

module.exports = router;
