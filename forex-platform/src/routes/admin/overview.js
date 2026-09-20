'use strict';
const express = require('express');
const { db } = require('../../db');
const { requirePermission } = require('../../middleware/auth');
const { asyncRoute } = require('../../middleware/common');

const router = express.Router();

const counts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM users)                                                   AS total_users,
    (SELECT COUNT(*) FROM users WHERE phone_verified_at IS NOT NULL)               AS verified_users,
    (SELECT COUNT(*) FROM users WHERE status = 'verification_required')            AS pending_verification,
    (SELECT COUNT(*) FROM users WHERE status IN ('suspended','banned'))            AS suspended_users,
    (SELECT COUNT(*) FROM users WHERE status IN ('duplicate_suspected','under_review')) AS review_users,
    (SELECT COUNT(*) FROM users WHERE created_at >= date('now','-30 days'))        AS new_users_30d,
    (SELECT COUNT(*) FROM kyc_records WHERE status IN ('pending','under_review'))  AS pending_kyc,
    (SELECT COUNT(*) FROM risk_flags WHERE status IN ('open','under_review'))      AS open_risk_flags,
    (SELECT COUNT(*) FROM support_requests WHERE status IN ('open','pending_user')) AS open_support
`);

const moneyCounts = db.prepare(`
  SELECT
    (SELECT COALESCE(SUM(amount_cents),0) FROM deposits WHERE status = 'verified')  AS verified_deposit_cents,
    (SELECT COUNT(*) FROM deposits WHERE status = 'verified')                       AS verified_deposit_count,
    (SELECT COALESCE(SUM(amount_cents),0) FROM deposits
      WHERE status IN ('pending','under_review','info_requested'))                  AS pending_deposit_cents,
    (SELECT COUNT(*) FROM deposits WHERE status IN ('pending','under_review','info_requested')) AS pending_deposit_count,
    (SELECT COUNT(*) FROM deposits WHERE status = 'rejected')                       AS rejected_deposit_count,
    (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals WHERE status = 'completed') AS completed_withdrawal_cents,
    (SELECT COUNT(*) FROM withdrawals WHERE status = 'completed')                   AS completed_withdrawal_count,
    (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals
      WHERE status IN ('pending','under_review','approved','processing'))           AS pending_withdrawal_cents,
    (SELECT COUNT(*) FROM withdrawals WHERE status IN ('pending','under_review','approved','processing')) AS pending_withdrawal_count,
    (SELECT COALESCE(SUM(principal_cents),0) FROM investments WHERE status = 'active') AS active_principal_cents,
    (SELECT COUNT(*) FROM investments WHERE status = 'active')                      AS active_investment_count,
    (SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END),0)
       FROM transactions WHERE type = 'profit_credit')                              AS realised_profit_cents
`);

const daily = db.prepare(`
  SELECT date(created_at) AS day,
         SUM(CASE WHEN status = 'verified' THEN amount_cents ELSE 0 END) AS verified_cents,
         COUNT(*) AS submissions
  FROM deposits WHERE created_at >= date('now','-30 days')
  GROUP BY day ORDER BY day ASC
`);

const signups = db.prepare(`
  SELECT date(created_at) AS day, COUNT(*) AS n FROM users
  WHERE created_at >= date('now','-30 days') GROUP BY day ORDER BY day ASC
`);

/**
 * Platform-wide totals.
 *
 * Every figure is a live aggregate over real rows. On a new installation they
 * are all zero, and the console shows an empty state rather than sample data.
 */
router.get('/overview', requirePermission('users.view', 'deposits.view', 'withdrawals.view'),
  asyncRoute(async (req, res) => {
    const liability = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END), 0) AS total_cents
      FROM transactions
    `).get().total_cents;

    res.json({
      users: counts.get(),
      money: moneyCounts.get(),
      // What the platform currently owes across all user accounts.
      outstandingLiabilityCents: liability,
      charts: {
        deposits: daily.all().map((d) => ({ date: d.day, verifiedCents: d.verified_cents, submissions: d.submissions })),
        signups: signups.all().map((s) => ({ date: s.day, count: s.n })),
      },
      queues: {
        deposits: db.prepare(
          `SELECT COUNT(*) AS c FROM deposits WHERE status IN ('pending','under_review')`
        ).get().c,
        withdrawals: db.prepare(
          `SELECT COUNT(*) AS c FROM withdrawals WHERE status IN ('pending','under_review')`
        ).get().c,
        kyc: db.prepare(`SELECT COUNT(*) AS c FROM kyc_records WHERE status IN ('pending','under_review')`).get().c,
        risk: db.prepare(`SELECT COUNT(*) AS c FROM risk_flags WHERE status = 'open'`).get().c,
        support: db.prepare(`SELECT COUNT(*) AS c FROM support_requests WHERE status = 'open'`).get().c,
      },
    });
  })
);

module.exports = router;
