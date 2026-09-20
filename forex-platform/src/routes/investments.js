'use strict';
const express = require('express');
const { db, tx } = require('../db');
const { check } = require('../lib/validate');
const { uniqueRef } = require('../lib/ids');
const money = require('../lib/money');
const ledger = require('../lib/ledger');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const settings = require('../lib/settings');
const present = require('../lib/present');
const sessionMw = require('../middleware/session');
const { requireUser, requireActiveUser } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/common');
const { AppError, notFound } = require('../lib/errors');

const router = express.Router();
router.use(requireUser);

const refExists = db.prepare('SELECT 1 FROM investments WHERE ref = ?');
const listStmt = db.prepare(
  'SELECT * FROM investments WHERE user_id = ? ORDER BY opened_at DESC, id DESC LIMIT ? OFFSET ?'
);
const countStmt = db.prepare('SELECT COUNT(*) AS c FROM investments WHERE user_id = ?');
const oneStmt = db.prepare('SELECT * FROM investments WHERE ref = ? AND user_id = ?');

router.get('/', asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    total: countStmt.get(req.user.id).c,
    items: listStmt.all(req.user.id, limitN, offset).map(present.investment),
    limits: settings.investmentLimits(),
    model: settings.illustrativeModel(),
    disclaimer: settings.get('illus_disclaimer', ''),
  });
}));

router.get('/:ref', asyncRoute(async (req, res) => {
  const row = oneStmt.get(req.params.ref, req.user.id);
  if (!row) throw notFound('No such investment.');
  res.json({
    investment: present.investment(row),
    history: audit.historyFor('investment', row.id).map(present.statusEvent),
    transactions: db.prepare(
      'SELECT * FROM transactions WHERE investment_id = ? ORDER BY created_at ASC'
    ).all(row.id).map(present.transaction),
  });
}));

/**
 * Commit available balance to an investment.
 *
 * The illustrative figures in force are snapshotted onto the row, so a later
 * change to the platform's model parameters cannot retroactively change what
 * the user was shown when they committed.
 *
 * Note what this does NOT do: it does not credit an illustrative figure to
 * anyone's balance, and it does not schedule one. Realised profit, if any, is
 * posted separately by an authorised member of staff with an audit record.
 */
router.post('/', requireActiveUser, sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  const v = check(req.body)
    .string('amount', { max: 20, label: 'Investment amount' })
    .bool('acknowledge_risk', { mustBeTrue: true, label: 'The risk acknowledgement' });

  const limits = settings.investmentLimits();
  const cents = money.parseToCents(req.body?.amount);
  if (cents === null) v.custom('amount', 'Enter an amount such as 250 or 1,000.50.', false);
  else {
    if (cents < limits.minCents) {
      v.custom('amount', `The minimum investment is ${money.formatCents(limits.minCents, { withSymbol: true })}.`, false);
    }
    if (cents > limits.maxCents) {
      v.custom('amount', `The maximum investment is ${money.formatCents(limits.maxCents, { withSymbol: true })}.`, false);
    }
  }
  v.done();

  const model = settings.illustrativeModel();
  const figures = money.illustrate(cents, model);
  const ref = uniqueRef('INV', 6, (c) => !!refExists.get(c));

  const created = tx(() => {
    const available = ledger.balancesFor(req.user.id).availableCents;
    if (cents > available) {
      throw new AppError(422, 'insufficient_funds',
        `You have ${money.formatCents(available, { withSymbol: true })} available. Make a deposit before committing more.`,
        { amount: `Your available balance is ${money.formatCents(available, { withSymbol: true })}.` });
    }
    const info = db.prepare(`
      INSERT INTO investments (ref, user_id, principal_cents, status, model_divisor, model_cycle_days,
                               illus_daily_cents, illus_cycle_cents)
      VALUES (?,?,?, 'active', ?,?,?,?)
    `).run(ref, req.user.id, cents, model.divisor, model.cycleDays, figures.dailyCents, figures.cycleCents);
    const id = Number(info.lastInsertRowid);

    // Two mirrored entries: cash leaves the available bucket, principal
    // enters the invested bucket. The total balance is unchanged.
    ledger.post({
      userId: req.user.id, type: 'investment_allocation', direction: 'debit', bucket: 'available',
      amountCents: cents, source: 'investment', investmentId: id,
      memo: `Allocated to investment ${ref}`,
    });
    ledger.post({
      userId: req.user.id, type: 'investment_allocation', direction: 'credit', bucket: 'invested',
      amountCents: cents, source: 'investment', investmentId: id,
      memo: `Principal held for investment ${ref}`,
    });
    return id;
  })();

  audit.record(req, {
    action: 'investment.opened', entityType: 'investment', entityId: created, entityLabel: ref,
    next: {
      principal_cents: cents,
      model: { divisor: model.divisor, cycle_days: model.cycleDays },
      illustrative: { daily_cents: figures.dailyCents, cycle_cents: figures.cycleCents },
    },
  });
  audit.status(req, { entityType: 'investment', entityId: created, from: null, to: 'active' });
  notify.notify(req.user.id, {
    type: 'investment.opened', severity: 'success',
    title: `Investment ${ref} opened`,
    body: `${money.formatCents(cents, { withSymbol: true })} has been committed. The illustrative figure for this amount is ${money.formatCents(figures.dailyCents, { withSymbol: true })} per day over ${model.cycleDays} market days — an example of the platform's calculation model, not a guaranteed return.`,
    link: `/app/#/investments/${ref}`,
  });

  res.status(201).json({ investment: present.investment(oneStmt.get(ref, req.user.id)) });
}));

module.exports = router;
