'use strict';
const { db } = require('../db');
const { uniqueRef } = require('./ids');

/**
 * The ledger.
 *
 * There is no mutable `balance` column in this system. Every figure a user or
 * an admin sees is a SUM over posted rows in `transactions`, and every row is
 * immutable once written (enforced by database triggers). A mistake is
 * corrected by posting a reversing entry, never by editing history.
 *
 * Two buckets exist:
 *   available — spendable cash the user could withdraw
 *   invested  — principal committed to an open investment
 */

const refExists = db.prepare('SELECT 1 FROM transactions WHERE txn_ref = ?');
const insertTxn = db.prepare(`
  INSERT INTO transactions
    (txn_ref, user_id, type, direction, bucket, amount_cents, currency, source, status,
     deposit_id, withdrawal_id, investment_id, reverses_txn_id, audit_log_id, memo)
  VALUES (@txn_ref, @user_id, @type, @direction, @bucket, @amount_cents, @currency, @source, 'posted',
          @deposit_id, @withdrawal_id, @investment_id, @reverses_txn_id, @audit_log_id, @memo)
`);

/**
 * Post a ledger entry. Must be called inside a transaction alongside whatever
 * workflow row (deposit/withdrawal/investment) it settles.
 */
function post({
  userId, type, direction, bucket = 'available', amountCents, currency = 'USD',
  source, depositId = null, withdrawalId = null, investmentId = null,
  reversesTxnId = null, auditLogId = null, memo = null,
}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('Ledger amounts must be a positive integer number of cents');
  }
  const txnRef = uniqueRef('TXN', 10, (c) => !!refExists.get(c));
  const info = insertTxn.run({
    txn_ref: txnRef,
    user_id: userId,
    type,
    direction,
    bucket,
    amount_cents: amountCents,
    currency,
    source,
    deposit_id: depositId,
    withdrawal_id: withdrawalId,
    investment_id: investmentId,
    reverses_txn_id: reversesTxnId,
    audit_log_id: auditLogId,
    memo,
  });
  return { id: Number(info.lastInsertRowid), txnRef };
}

const markReversed = db.prepare(
  `UPDATE transactions SET status = 'reversed', updated_at = datetime('now') WHERE id = ? AND status = 'posted'`
);

/**
 * Post the mirror image of `original` and mark the original as reversed.
 *
 * The mirror is what cancels the original financially. The status flag is for
 * display only — balance aggregates deliberately count both rows, because
 * excluding the original as well would undo the movement twice.
 */
function reverse(originalId, { memo, auditLogId } = {}) {
  const original = db.prepare('SELECT * FROM transactions WHERE id = ?').get(originalId);
  if (!original) throw new Error(`No such transaction: ${originalId}`);
  if (original.status !== 'posted') throw new Error('Transaction is already reversed');
  const mirror = post({
    userId: original.user_id,
    type: original.type === 'withdrawal_hold' ? 'withdrawal_release' : original.type,
    direction: original.direction === 'credit' ? 'debit' : 'credit',
    bucket: original.bucket,
    amountCents: original.amount_cents,
    currency: original.currency,
    source: original.source,
    depositId: original.deposit_id,
    withdrawalId: original.withdrawal_id,
    investmentId: original.investment_id,
    reversesTxnId: original.id,
    auditLogId: auditLogId ?? null,
    memo: memo || `Reversal of ${original.txn_ref}`,
  });
  markReversed.run(original.id);
  return mirror;
}

const balanceStmt = db.prepare('SELECT * FROM v_user_balances WHERE user_id = ?');

const aggregatesStmt = db.prepare(`
  SELECT
    (SELECT COALESCE(SUM(amount_cents),0) FROM deposits
      WHERE user_id = @uid AND status = 'verified')                                   AS total_deposited_cents,
    (SELECT COALESCE(SUM(amount_cents),0) FROM deposits
      WHERE user_id = @uid AND status IN ('pending','under_review','info_requested')) AS pending_deposit_cents,
    (SELECT COUNT(*) FROM deposits
      WHERE user_id = @uid AND status IN ('pending','under_review','info_requested')) AS pending_deposit_count,
    (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals
      WHERE user_id = @uid AND status = 'completed')                                  AS total_withdrawn_cents,
    (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals
      WHERE user_id = @uid AND status IN ('pending','under_review','approved','processing')) AS pending_withdrawal_cents,
    (SELECT COUNT(*) FROM withdrawals
      WHERE user_id = @uid AND status IN ('pending','under_review','approved','processing')) AS pending_withdrawal_count
`);

/**
 * The single source of truth for every figure rendered on a dashboard.
 * Computed server-side on each request; nothing here is ever accepted from
 * or reconciled against a client-supplied value.
 */
function balancesFor(userId) {
  const b = balanceStmt.get(userId) || { available_cents: 0, invested_cents: 0, realized_profit_cents: 0 };
  const agg = aggregatesStmt.get({ uid: userId });
  return {
    availableCents: b.available_cents,
    investedCents: b.invested_cents,
    realizedProfitCents: b.realized_profit_cents,
    // "Total balance" is cash on hand plus principal currently committed.
    // It deliberately excludes unverified deposits and illustrative figures.
    totalCents: b.available_cents + b.invested_cents,
    pendingDepositCents: agg.pending_deposit_cents,
    pendingDepositCount: agg.pending_deposit_count,
    pendingWithdrawalCents: agg.pending_withdrawal_cents,
    pendingWithdrawalCount: agg.pending_withdrawal_count,
    totalDepositedCents: agg.total_deposited_cents,
    totalWithdrawnCents: agg.total_withdrawn_cents,
  };
}

module.exports = { post, reverse, balancesFor };
