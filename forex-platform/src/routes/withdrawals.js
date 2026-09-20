'use strict';
const express = require('express');
const { db, tx } = require('../db');
const { check } = require('../lib/validate');
const { uniqueRef } = require('../lib/ids');
const money = require('../lib/money');
const ledger = require('../lib/ledger');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const risk = require('../lib/risk');
const settings = require('../lib/settings');
const present = require('../lib/present');
const phoneLib = require('../lib/phone');
const sessionMw = require('../middleware/session');
const { requireUser, requireActiveUser } = require('../middleware/auth');
const { asyncRoute, limit } = require('../middleware/common');
const { AppError, notFound, bad } = require('../lib/errors');

const router = express.Router();
router.use(requireUser);

const methodsStmt = db.prepare(`
  SELECT id, key, name, provider FROM payment_methods
  WHERE is_active = 1 AND for_withdrawal = 1 ORDER BY sort_order, name
`);
const methodById = db.prepare('SELECT * FROM payment_methods WHERE id = ? AND is_active = 1 AND for_withdrawal = 1');
const refExists = db.prepare('SELECT 1 FROM withdrawals WHERE ref = ?');
const listStmt = db.prepare(`
  SELECT w.*, pm.name AS method_name FROM withdrawals w JOIN payment_methods pm ON pm.id = w.method_id
  WHERE w.user_id = ? ORDER BY w.created_at DESC, w.id DESC LIMIT ? OFFSET ?
`);
const countStmt = db.prepare('SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ?');
const oneStmt = db.prepare(`
  SELECT w.*, pm.name AS method_name FROM withdrawals w JOIN payment_methods pm ON pm.id = w.method_id
  WHERE w.ref = ? AND w.user_id = ?
`);

const CANCELLABLE = ['pending', 'under_review'];

router.get('/options', asyncRoute(async (req, res) => {
  const balances = ledger.balancesFor(req.user.id);
  const whatsapp = settings.get('support_whatsapp', '');
  res.json({
    enabled: settings.get('withdrawals_enabled', true),
    minCents: settings.get('withdrawal_min_cents', 1000),
    feeBps: settings.get('withdrawal_fee_bps', 0),
    rules: settings.get('withdrawal_rules', ''),
    availableCents: balances.availableCents,
    kycRequired: settings.get('kyc_required', false),
    whatsapp: settings.get('withdrawal_whatsapp_enabled', true)
      ? { digits: phoneLib.toWhatsappDigits(whatsapp), display: phoneLib.formatLocal(phoneLib.normalisePk(whatsapp) || whatsapp) }
      : null,
    methods: methodsStmt.all().map((m) => ({ id: m.id, key: m.key, name: m.name, provider: m.provider })),
  });
}));

router.get('/', asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    total: countStmt.get(req.user.id).c,
    items: listStmt.all(req.user.id, limitN, offset)
      .map((w) => present.withdrawal(w, { cancellable: CANCELLABLE.includes(w.status) })),
  });
}));

router.get('/:ref', asyncRoute(async (req, res) => {
  const row = oneStmt.get(req.params.ref, req.user.id);
  if (!row) throw notFound('No such withdrawal.');
  res.json({
    withdrawal: present.withdrawal(row, { cancellable: CANCELLABLE.includes(row.status) }),
    history: audit.historyFor('withdrawal', row.id).map(present.statusEvent),
  });
}));

/**
 * Request a withdrawal.
 *
 * The amount is debited from the available balance the moment the request is
 * accepted — a hold — so the same money cannot be requested twice while the
 * first request is in the queue. If the request is later rejected or
 * cancelled, the hold is reversed by a mirrored ledger entry.
 *
 * The available balance is read inside the same immediate transaction that
 * writes the hold, so two concurrent requests cannot both pass the check.
 */
router.post('/',
  requireActiveUser,
  sessionMw.requireCsrf,
  limit({ name: 'withdraw:create', max: 10, windowMs: 60 * 60 * 1000, keyBy: (req) => req.user.id }),
  asyncRoute(async (req, res) => {
    if (!settings.get('withdrawals_enabled', true)) {
      throw new AppError(503, 'withdrawals_closed', 'Withdrawals are temporarily unavailable. Please try again later.');
    }
    if (settings.get('kyc_required', false)) {
      const kyc = db.prepare(`SELECT status FROM kyc_records WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(req.user.id);
      if (!kyc || kyc.status !== 'approved') {
        throw new AppError(403, 'kyc_required',
          'Identity verification must be approved before you can withdraw. Submit your documents from the verification page.');
      }
    }

    const v = check(req.body)
      .string('amount', { max: 20, label: 'Withdrawal amount' })
      .int('method_id', { label: 'Payment method' })
      .string('payout_title', { min: 2, max: 120, label: 'Account title' })
      .string('payout_account', { min: 5, max: 40, label: 'Account number' });

    const minCents = settings.get('withdrawal_min_cents', 1000);
    const cents = money.parseToCents(req.body?.amount);
    if (cents === null) v.custom('amount', 'Enter an amount such as 100 or 1,250.50.', false);
    else if (cents < minCents) {
      v.custom('amount', `The minimum withdrawal is ${money.formatCents(minCents, { withSymbol: true })}.`, false);
    }

    const method = methodById.get(Number(req.body?.method_id));
    if (!method) v.custom('method_id', 'Choose one of the available payout methods.', false);

    const data = v.done();

    const feeBps = settings.get('withdrawal_fee_bps', 0);
    const feeCents = Math.floor((cents * feeBps) / 10000);
    const netCents = cents - feeCents;
    if (netCents <= 0) throw bad('The fee on that amount leaves nothing to pay out. Request a larger amount.');

    const ref = uniqueRef('WDR', 8, (c) => !!refExists.get(c));

    let created;
    try {
      created = tx(() => {
        const available = ledger.balancesFor(req.user.id).availableCents;
        if (cents > available) {
          throw new AppError(422, 'insufficient_funds',
            `You can withdraw up to ${money.formatCents(available, { withSymbol: true })} right now.`,
            { amount: `Your available balance is ${money.formatCents(available, { withSymbol: true })}.` });
        }
        const info = db.prepare(`
          INSERT INTO withdrawals (ref, user_id, amount_cents, fee_cents, net_cents, method_id,
                                   payout_title, payout_account, status)
          VALUES (?,?,?,?,?,?,?,?, 'pending')
        `).run(ref, req.user.id, cents, feeCents, netCents, method.id, data.payout_title, data.payout_account);
        const id = Number(info.lastInsertRowid);

        const hold = ledger.post({
          userId: req.user.id,
          type: 'withdrawal_hold',
          direction: 'debit',
          bucket: 'available',
          amountCents: cents,
          source: 'withdrawal',
          withdrawalId: id,
          memo: `Held against withdrawal request ${ref}`,
        });
        db.prepare('UPDATE withdrawals SET hold_txn_id = ? WHERE id = ?').run(hold.id, id);
        return { id, holdRef: hold.txnRef };
      })();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw err;
    }

    audit.record(req, {
      action: 'withdrawal.requested', entityType: 'withdrawal', entityId: created.id, entityLabel: ref,
      next: { amount_cents: cents, fee_cents: feeCents, net_cents: netCents, method: method.key, hold: created.holdRef },
    });
    audit.status(req, {
      entityType: 'withdrawal', entityId: created.id, from: null, to: 'pending',
      note: `Requested by the account holder. ${money.formatCents(cents, { withSymbol: true })} placed on hold.`,
    });
    risk.checkPayoutReuse(req, req.user.id, data.payout_account);

    notify.notify(req.user.id, {
      type: 'withdrawal.submitted', severity: 'info',
      title: `Withdrawal ${ref} submitted`,
      body: `Your request for ${money.formatCents(cents, { withSymbol: true })} is in the review queue. That amount is on hold and will be returned to your available balance if the request is rejected or cancelled.`,
      link: `/app/#/withdrawals/${ref}`,
      smsText: `Withdrawal ${ref} for ${money.formatCents(cents, { withSymbol: true })} submitted for review.`,
    });

    res.status(201).json({ withdrawal: present.withdrawal(oneStmt.get(ref, req.user.id), { cancellable: true }) });
  })
);

router.post('/:ref/cancel', sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  const row = oneStmt.get(req.params.ref, req.user.id);
  if (!row) throw notFound('No such withdrawal.');
  if (!CANCELLABLE.includes(row.status)) {
    throw bad(`A withdrawal that is ${row.status} can no longer be cancelled. Contact support if you need help.`);
  }

  const auditId = audit.record(req, {
    action: 'withdrawal.cancelled', entityType: 'withdrawal', entityId: row.id, entityLabel: row.ref,
    previous: row.status, next: 'cancelled', reason: 'Cancelled by the account holder',
  });

  tx(() => {
    db.prepare(`UPDATE withdrawals SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(row.id);
    if (row.hold_txn_id) {
      const release = ledger.reverse(row.hold_txn_id, {
        memo: `Hold released — withdrawal ${row.ref} cancelled by the account holder`,
        auditLogId: auditId,
      });
      db.prepare('UPDATE withdrawals SET release_txn_id = ? WHERE id = ?').run(release.id, row.id);
    }
  })();

  audit.status(req, {
    entityType: 'withdrawal', entityId: row.id, from: row.status, to: 'cancelled',
    note: 'Cancelled by the account holder; hold released back to available balance',
  });
  notify.notify(req.user.id, {
    type: 'withdrawal.cancelled', severity: 'info',
    title: `Withdrawal ${row.ref} cancelled`,
    body: `${money.formatCents(row.amount_cents, { withSymbol: true })} has been returned to your available balance.`,
    link: `/app/#/withdrawals/${row.ref}`,
  });

  res.json({ ok: true, withdrawal: present.withdrawal(oneStmt.get(row.ref, req.user.id), { cancellable: false }) });
}));

module.exports = router;
