'use strict';
const express = require('express');
const { db, tx } = require('../../db');
const present = require('../../lib/present');
const ledger = require('../../lib/ledger');
const audit = require('../../lib/audit');
const notify = require('../../lib/notify');
const money = require('../../lib/money');
const phoneLib = require('../../lib/phone');
const { check } = require('../../lib/validate');
const sessionMw = require('../../middleware/session');
const { requirePermission } = require('../../middleware/auth');
const { asyncRoute } = require('../../middleware/common');
const { AppError, notFound, bad } = require('../../lib/errors');

const router = express.Router();

// ===========================================================================
// Deposits
// ===========================================================================
const DEPOSIT_STATUSES = ['pending', 'under_review', 'info_requested', 'verified', 'rejected', 'cancelled'];

router.get('/deposits', requirePermission('deposits.view'), asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 25, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const status = DEPOSIT_STATUSES.includes(req.query.status) ? req.query.status : null;
  const q = String(req.query.q || '').trim().slice(0, 80);

  const clauses = [];
  const params = {};
  if (status) { clauses.push('d.status = @status'); params.status = status; }
  if (q) {
    clauses.push('(d.ref LIKE @q OR d.provider_txn_ref LIKE @q OR u.public_id LIKE @q OR u.full_name LIKE @q OR u.phone_e164 LIKE @q)');
    params.q = `%${q}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM deposits d JOIN users u ON u.id = d.user_id ${where}`
  ).get(params).c;
  const rows = db.prepare(`
    SELECT d.*, pm.name AS method_name, pm.key AS method_key,
           u.public_id, u.full_name, u.phone_e164, u.status AS user_status,
           (SELECT COUNT(*) FROM deposit_evidence de WHERE de.deposit_id = d.id) AS evidence_count
    FROM deposits d JOIN users u ON u.id = d.user_id JOIN payment_methods pm ON pm.id = d.method_id
    ${where} ORDER BY
      CASE d.status WHEN 'pending' THEN 0 WHEN 'under_review' THEN 1 WHEN 'info_requested' THEN 2 ELSE 3 END,
      d.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: limitN, offset });

  res.json({
    total,
    statuses: DEPOSIT_STATUSES,
    items: rows.map((d) => present.deposit(d, {
      user: {
        publicId: d.public_id, fullName: d.full_name,
        phone: phoneLib.formatLocal(d.phone_e164), status: d.user_status,
      },
    })),
  });
}));

const depositByRef = db.prepare(`
  SELECT d.*, pm.name AS method_name, pm.key AS method_key, pm.account_number AS receiving_account,
         u.id AS uid, u.public_id, u.full_name, u.phone_e164, u.status AS user_status, u.created_at AS user_since
  FROM deposits d JOIN users u ON u.id = d.user_id JOIN payment_methods pm ON pm.id = d.method_id
  WHERE d.ref = ?
`);

/**
 * Full review context for one deposit: the claim, the evidence, the receiving
 * account it should have landed in, and the submitting account's history.
 *
 * The evidence image is supporting material. It is NOT proof of receipt —
 * a screenshot can be edited, reused or fabricated. The response carries the
 * reconciliation checklist the reviewer is expected to work through.
 */
router.get('/deposits/:ref', requirePermission('deposits.view'), asyncRoute(async (req, res) => {
  const d = depositByRef.get(req.params.ref);
  if (!d) throw notFound('No such deposit.');

  const sameRef = db.prepare(
    'SELECT ref, status, created_at FROM deposits WHERE provider_txn_ref = ? AND id <> ?'
  ).all(d.provider_txn_ref, d.id);

  res.json({
    deposit: present.deposit(d),
    user: {
      publicId: d.public_id,
      fullName: d.full_name,
      phone: phoneLib.formatLocal(d.phone_e164),
      status: d.user_status,
      memberSince: d.user_since,
      balances: ledger.balancesFor(d.uid),
      history: db.prepare(`
        SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS cents
        FROM deposits WHERE user_id = ? GROUP BY status
      `).all(d.uid),
      openFlags: db.prepare(
        `SELECT COUNT(*) AS c FROM risk_flags WHERE user_id = ? AND status IN ('open','under_review')`
      ).get(d.uid).c,
    },
    receivingAccount: d.receiving_account,
    evidence: db.prepare(`
      SELECT f.id, f.original_name, f.mime, f.size_bytes, f.sha256, f.scan_status, f.created_at,
        (SELECT COUNT(*) FROM files f2 WHERE f2.sha256 = f.sha256) AS identical_uploads
      FROM deposit_evidence de JOIN files f ON f.id = de.file_id WHERE de.deposit_id = ?
    `).all(d.id).map((f) => ({
      id: f.id, name: f.original_name, mime: f.mime, sizeBytes: f.size_bytes,
      sha256: f.sha256, scanStatus: f.scan_status, uploadedAt: f.created_at,
      // The same bytes uploaded more than once is worth a reviewer's attention.
      identicalUploads: f.identical_uploads,
      url: `/api/admin/files/${f.id}`,
    })),
    duplicateReferences: sameRef,
    verificationChecklist: [
      'Match the transaction ID against the receiving account statement or the provider portal.',
      'Confirm the amount received equals the amount claimed, to the cent.',
      'Confirm the sending account matches the details the user submitted.',
      'Confirm the payment timestamp is consistent with the claim.',
      'Treat the screenshot as supporting material only — it is not evidence of receipt on its own.',
    ],
    history: audit.historyFor('deposit', d.id).map(present.statusEvent),
  });
}));

const DEPOSIT_DECISIONS = {
  verify: 'verified',
  reject: 'rejected',
  request_info: 'info_requested',
  under_review: 'under_review',
};

/**
 * Decide a deposit. Only `verify` moves money, and it does so by posting a
 * ledger credit inside the same transaction that flips the status, with the
 * audit record written first so the ledger row references it.
 */
router.post('/deposits/:ref/decision', requirePermission('deposits.review'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const d = depositByRef.get(req.params.ref);
    if (!d) throw notFound('No such deposit.');

    const v = check(req.body)
      .enum('decision', Object.keys(DEPOSIT_DECISIONS), { label: 'Decision' })
      .string('note', { required: false, max: 500, label: 'Note' });
    const data = v.done();
    const next = DEPOSIT_DECISIONS[data.decision];

    if (['verified', 'rejected', 'cancelled'].includes(d.status)) {
      throw bad(`This deposit is already ${d.status} and cannot be decided again. Post a balance adjustment if a correction is needed.`);
    }
    if (next === 'rejected' && !data.note) {
      throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
        { note: 'Give the user a reason for the rejection.' });
    }
    if (next === 'verified') {
      const confirmed = req.body?.confirm_reconciled === true || req.body?.confirm_reconciled === 'true';
      if (!confirmed) {
        throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.', {
          confirm_reconciled: 'Confirm you have matched this payment against the receiving account records before crediting it.',
        });
      }
    }

    const auditId = audit.record(req, {
      action: `deposit.${data.decision}`, entityType: 'deposit', entityId: d.id, entityLabel: d.ref,
      previous: d.status, next, reason: data.note,
    });

    let txnRef = null;
    tx(() => {
      db.prepare(`
        UPDATE deposits SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'),
          review_note = ?, updated_at = datetime('now') WHERE id = ?
      `).run(next, req.admin.id, data.note, d.id);

      if (next === 'verified') {
        const credit = ledger.post({
          userId: d.uid, type: 'deposit_credit', direction: 'credit', bucket: 'available',
          amountCents: d.amount_cents, source: 'deposit', depositId: d.id, auditLogId: auditId,
          memo: `Deposit ${d.ref} verified against receiving account records by ${req.admin.public_id}`,
        });
        db.prepare('UPDATE deposits SET credit_txn_id = ? WHERE id = ?').run(credit.id, d.id);
        txnRef = credit.txnRef;
      }
    })();

    audit.status(req, {
      entityType: 'deposit', entityId: d.id, from: d.status, to: next, note: data.note,
    });

    const messages = {
      verified: {
        severity: 'success',
        title: `Deposit ${d.ref} verified`,
        body: `${money.formatCents(d.amount_cents, { withSymbol: true })} has been credited to your available balance. Reference ${txnRef}.`,
      },
      rejected: {
        severity: 'warning',
        title: `Deposit ${d.ref} rejected`,
        body: `${data.note} Nothing has been credited. Contact support if you believe this is a mistake.`,
      },
      info_requested: {
        severity: 'warning',
        title: `More information needed for deposit ${d.ref}`,
        body: data.note || 'Our team needs more information about this payment before it can be verified.',
      },
      under_review: {
        severity: 'info',
        title: `Deposit ${d.ref} is under review`,
        body: data.note || 'Our team is reviewing this payment against our receiving account records.',
      },
    };
    notify.notify(d.uid, {
      type: `deposit.${next}`, ...messages[next], link: `/app/#/deposits/${d.ref}`,
      smsText: next === 'verified'
        ? `Deposit ${d.ref} verified. ${money.formatCents(d.amount_cents, { withSymbol: true })} credited.`
        : null,
    });

    res.json({ ok: true, status: next, transaction: txnRef });
  })
);

// ===========================================================================
// Withdrawals
// ===========================================================================
const WITHDRAWAL_STATUSES = ['pending', 'under_review', 'approved', 'processing', 'completed', 'rejected', 'cancelled'];

router.get('/withdrawals', requirePermission('withdrawals.view'), asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 25, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const status = WITHDRAWAL_STATUSES.includes(req.query.status) ? req.query.status : null;
  const q = String(req.query.q || '').trim().slice(0, 80);

  const clauses = [];
  const params = {};
  if (status) { clauses.push('w.status = @status'); params.status = status; }
  if (q) {
    clauses.push('(w.ref LIKE @q OR u.public_id LIKE @q OR u.full_name LIKE @q OR u.phone_e164 LIKE @q)');
    params.q = `%${q}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM withdrawals w JOIN users u ON u.id = w.user_id ${where}`
  ).get(params).c;
  const rows = db.prepare(`
    SELECT w.*, pm.name AS method_name, u.public_id, u.full_name, u.phone_e164, u.status AS user_status
    FROM withdrawals w JOIN users u ON u.id = w.user_id JOIN payment_methods pm ON pm.id = w.method_id
    ${where} ORDER BY
      CASE w.status WHEN 'pending' THEN 0 WHEN 'under_review' THEN 1 WHEN 'approved' THEN 2
                    WHEN 'processing' THEN 3 ELSE 4 END,
      w.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: limitN, offset });

  res.json({
    total,
    statuses: WITHDRAWAL_STATUSES,
    items: rows.map((w) => present.withdrawal(w, {
      user: {
        publicId: w.public_id, fullName: w.full_name,
        phone: phoneLib.formatLocal(w.phone_e164), status: w.user_status,
      },
    })),
  });
}));

const withdrawalByRef = db.prepare(`
  SELECT w.*, pm.name AS method_name, u.id AS uid, u.public_id, u.full_name, u.phone_e164,
         u.status AS user_status, u.created_at AS user_since
  FROM withdrawals w JOIN users u ON u.id = w.user_id JOIN payment_methods pm ON pm.id = w.method_id
  WHERE w.ref = ?
`);

router.get('/withdrawals/:ref', requirePermission('withdrawals.view'), asyncRoute(async (req, res) => {
  const w = withdrawalByRef.get(req.params.ref);
  if (!w) throw notFound('No such withdrawal.');
  res.json({
    // The full payout account is shown here because finance staff must key it
    // into the payment provider. This view requires withdrawals.view and the
    // request is recorded like any other administrative read.
    withdrawal: { ...present.withdrawal(w), payoutAccount: w.payout_account },
    user: {
      publicId: w.public_id, fullName: w.full_name, phone: phoneLib.formatLocal(w.phone_e164),
      status: w.user_status, memberSince: w.user_since, balances: ledger.balancesFor(w.uid),
      totalDepositedCents: db.prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS c FROM deposits WHERE user_id = ? AND status = 'verified'`
      ).get(w.uid).c,
      priorWithdrawals: db.prepare(
        `SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ? AND status = 'completed'`
      ).get(w.uid).c,
      openFlags: db.prepare(
        `SELECT COUNT(*) AS c FROM risk_flags WHERE user_id = ? AND status IN ('open','under_review')`
      ).get(w.uid).c,
    },
    // The same payout account used by another account is a strong duplicate signal.
    payoutSharedWith: db.prepare(`
      SELECT DISTINCT u.public_id, u.full_name FROM withdrawals w2 JOIN users u ON u.id = w2.user_id
      WHERE w2.payout_account = ? AND w2.user_id <> ?
    `).all(w.payout_account, w.uid),
    history: audit.historyFor('withdrawal', w.id).map(present.statusEvent),
  });
}));

const WITHDRAWAL_TRANSITIONS = {
  pending: ['under_review', 'approved', 'rejected'],
  under_review: ['approved', 'rejected'],
  approved: ['processing', 'rejected'],
  processing: ['completed', 'rejected'],
  completed: [],
  rejected: [],
  cancelled: [],
};

/**
 * Advance a withdrawal through its workflow.
 *
 * The ledger consequences are:
 *   rejected  — the hold taken at request time is reversed, returning the
 *               money to the user's available balance
 *   completed — the hold is reversed and a settlement debit is posted, so the
 *               final ledger reads as a payout rather than a standing hold
 * Everything else is a status move with no financial effect.
 */
router.post('/withdrawals/:ref/decision', sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  const w = withdrawalByRef.get(req.params.ref);
  if (!w) throw notFound('No such withdrawal.');

  const v = check(req.body)
    .enum('status', WITHDRAWAL_STATUSES, { label: 'Status' })
    .string('note', { required: false, max: 500, label: 'Note' })
    .string('provider_ref', { required: false, max: 80, label: 'Provider reference' });
  const data = v.done();

  const allowed = WITHDRAWAL_TRANSITIONS[w.status] || [];
  if (!allowed.includes(data.status)) {
    throw bad(
      allowed.length
        ? `A ${w.status} withdrawal can only move to: ${allowed.join(', ')}.`
        : `A ${w.status} withdrawal is final and cannot be changed. Post a balance adjustment if a correction is needed.`
    );
  }

  // Permission is split: reviewing (approve/reject) and processing (pay out)
  // are different jobs and are checked separately.
  const needsProcess = ['processing', 'completed'].includes(data.status);
  const permission = needsProcess ? 'withdrawals.process' : 'withdrawals.review';
  if (!req.adminPermissions.has(permission)) {
    throw new AppError(403, 'forbidden', `Your role does not include the ${permission} permission.`);
  }
  if (data.status === 'rejected' && !data.note) {
    throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
      { note: 'Give the user a reason for the rejection.' });
  }
  if (data.status === 'completed' && !data.provider_ref) {
    throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
      { provider_ref: 'Record the payment provider reference for this payout.' });
  }

  const auditId = audit.record(req, {
    action: `withdrawal.${data.status}`, entityType: 'withdrawal', entityId: w.id, entityLabel: w.ref,
    previous: w.status, next: data.status, reason: data.note,
  });

  let settleRef = null;
  tx(() => {
    db.prepare(`
      UPDATE withdrawals SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'),
        review_note = COALESCE(?, review_note), provider_ref = COALESCE(?, provider_ref),
        processed_at = CASE WHEN ? IN ('completed') THEN datetime('now') ELSE processed_at END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(data.status, req.admin.id, data.note, data.provider_ref, data.status, w.id);

    if (data.status === 'rejected' && w.hold_txn_id) {
      const release = ledger.reverse(w.hold_txn_id, {
        memo: `Hold released — withdrawal ${w.ref} rejected by ${req.admin.public_id}`,
        auditLogId: auditId,
      });
      db.prepare('UPDATE withdrawals SET release_txn_id = ? WHERE id = ?').run(release.id, w.id);
    }

    if (data.status === 'completed') {
      if (w.hold_txn_id) {
        const release = ledger.reverse(w.hold_txn_id, {
          memo: `Hold converted to settlement for withdrawal ${w.ref}`,
          auditLogId: auditId,
        });
        db.prepare('UPDATE withdrawals SET release_txn_id = ? WHERE id = ?').run(release.id, w.id);
      }
      const settle = ledger.post({
        userId: w.uid, type: 'withdrawal_settle', direction: 'debit', bucket: 'available',
        amountCents: w.amount_cents, source: 'withdrawal', withdrawalId: w.id, auditLogId: auditId,
        memo: `Withdrawal ${w.ref} paid out (provider reference ${data.provider_ref})`,
      });
      settleRef = settle.txnRef;
    }
  })();

  audit.status(req, {
    entityType: 'withdrawal', entityId: w.id, from: w.status, to: data.status, note: data.note,
  });

  const titles = {
    under_review: `Withdrawal ${w.ref} is under review`,
    approved: `Withdrawal ${w.ref} approved`,
    processing: `Withdrawal ${w.ref} is being processed`,
    completed: `Withdrawal ${w.ref} paid out`,
    rejected: `Withdrawal ${w.ref} rejected`,
  };
  const bodies = {
    under_review: data.note || 'Our finance team is reviewing your request.',
    approved: data.note || 'Your request has been approved and is queued for payout.',
    processing: data.note || 'Your payout is being sent to your nominated account.',
    completed: `${money.formatCents(w.net_cents, { withSymbol: true })} has been sent to your nominated account. Provider reference ${data.provider_ref}.`,
    rejected: `${data.note} ${money.formatCents(w.amount_cents, { withSymbol: true })} has been returned to your available balance.`,
  };
  notify.notify(w.uid, {
    type: `withdrawal.${data.status}`,
    severity: data.status === 'completed' ? 'success' : data.status === 'rejected' ? 'warning' : 'info',
    title: titles[data.status],
    body: bodies[data.status],
    link: `/app/#/withdrawals/${w.ref}`,
    smsText: ['completed', 'rejected'].includes(data.status) ? `${titles[data.status]}.` : null,
  });

  res.json({ ok: true, status: data.status, settlement: settleRef });
}));

// ===========================================================================
// Ledger (cross-account)
// ===========================================================================
router.get('/ledger', requirePermission('ledger.view'), asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = db.prepare(`
    SELECT t.*, u.public_id, u.full_name FROM transactions t JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?
  `).all(limitN, offset);
  res.json({
    total: db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c,
    items: rows.map((t) => ({
      ...present.transaction(t),
      user: { publicId: t.public_id, fullName: t.full_name },
    })),
  });
}));

module.exports = router;
