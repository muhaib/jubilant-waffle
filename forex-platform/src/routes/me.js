'use strict';
const express = require('express');
const { db, tx } = require('../db');
const ledger = require('../lib/ledger');
const present = require('../lib/present');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const settings = require('../lib/settings');
const money = require('../lib/money');
const phoneLib = require('../lib/phone');
const { check } = require('../lib/validate');
const { hashPassword, verifyPassword, passwordProblems } = require('../lib/password');
const sessionMw = require('../middleware/session');
const { requireUser } = require('../middleware/auth');
const { asyncRoute, limit } = require('../middleware/common');
const { AppError, notFound } = require('../lib/errors');

const router = express.Router();
router.use(requireUser);

const profileStmt = db.prepare('SELECT * FROM user_profiles WHERE user_id = ?');
const kycStmt = db.prepare('SELECT * FROM kyc_records WHERE user_id = ? ORDER BY id DESC LIMIT 1');

function verificationState(user) {
  const kyc = kycStmt.get(user.id);
  return {
    phone: { done: Boolean(user.phone_verified_at), at: user.phone_verified_at },
    identity: kyc
      ? {
        submitted: true,
        status: kyc.status,
        masked: present.maskIdentityNumber(kyc.id_prefix, kyc.id_last),
        submittedAt: kyc.created_at,
        reviewedAt: kyc.reviewed_at,
        note: kyc.review_note,
      }
      : { submitted: false, status: null, required: settings.get('kyc_required', false) },
    accountStatus: user.status,
  };
}

router.get('/', asyncRoute(async (req, res) => {
  const profile = profileStmt.get(req.user.id) || {};
  res.json({
    user: present.user(req.user),
    profile: {
      dateOfBirth: profile.date_of_birth || null,
      addressLine: profile.address_line || null,
      city: profile.city || null,
      country: profile.country || 'PK',
      occupation: profile.occupation || null,
    },
    verification: verificationState(req.user),
    balances: ledger.balancesFor(req.user.id),
  });
}));

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
const recentTxns = db.prepare(
  'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
);
const activeInvestments = db.prepare(
  `SELECT * FROM investments WHERE user_id = ? AND status IN ('active','closing') ORDER BY opened_at DESC`
);
const dailyFlow = db.prepare(`
  SELECT date(created_at) AS day,
         SUM(CASE WHEN direction = 'credit' AND bucket = 'available' THEN amount_cents ELSE 0 END) AS credits,
         SUM(CASE WHEN direction = 'debit'  AND bucket = 'available' THEN amount_cents ELSE 0 END) AS debits
  FROM transactions
  WHERE user_id = ? AND created_at >= date('now', ?)
  GROUP BY day ORDER BY day ASC
`);
const openingBalance = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END), 0) AS cents
  FROM transactions
  WHERE user_id = ? AND bucket = 'available' AND created_at < date('now', ?)
`);
const monthlyFlow = db.prepare(`
  SELECT strftime('%Y-%m', created_at) AS month,
         SUM(CASE WHEN type = 'deposit_credit'    AND direction = 'credit' THEN amount_cents
                  WHEN type = 'deposit_credit'    AND direction = 'debit'  THEN -amount_cents
                  ELSE 0 END) AS deposited,
         SUM(CASE WHEN type = 'withdrawal_settle' AND direction = 'debit'  THEN amount_cents
                  WHEN type = 'withdrawal_settle' AND direction = 'credit' THEN -amount_cents
                  ELSE 0 END) AS withdrawn,
         SUM(CASE WHEN type = 'profit_credit'     AND direction = 'credit' THEN amount_cents
                  WHEN type = 'profit_credit'     AND direction = 'debit'  THEN -amount_cents
                  ELSE 0 END) AS profit
  FROM transactions
  WHERE user_id = ? AND created_at >= date('now', '-12 months')
  GROUP BY month ORDER BY month ASC
`);

/**
 * Dashboard payload.
 *
 * Every series here is derived from the user's own posted ledger entries.
 * Nothing is simulated, and an account with no activity returns empty series
 * so the UI can show a genuine empty state instead of an invented curve.
 */
router.get('/dashboard', asyncRoute(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);
  const window = `-${days} days`;

  const balances = ledger.balancesFor(req.user.id);
  const investments = activeInvestments.all(req.user.id).map(present.investment);
  const model = settings.illustrativeModel();

  // Running available balance, reconstructed day by day from the ledger.
  let running = openingBalance.get(req.user.id, window).cents;
  const flow = dailyFlow.all(req.user.id, window);
  const balanceSeries = flow.map((row) => {
    running += row.credits - row.debits;
    return { date: row.day, balanceCents: running, creditsCents: row.credits, debitsCents: row.debits };
  });

  const principalCents = investments.reduce((sum, i) => sum + i.principalCents, 0);
  const illustrative = principalCents > 0 ? money.illustrate(principalCents, model) : null;

  res.json({
    user: present.user(req.user),
    balances,
    verification: verificationState(req.user),
    investments,
    illustrative: illustrative && {
      basisCents: principalCents,
      dailyCents: illustrative.dailyCents,
      cycleCents: illustrative.cycleCents,
      divisor: model.divisor,
      cycleDays: model.cycleDays,
      disclaimer: settings.get('illus_disclaimer', ''),
    },
    charts: {
      balance: balanceSeries,
      monthly: monthlyFlow.all(req.user.id).map((m) => ({
        month: m.month,
        depositedCents: m.deposited,
        withdrawnCents: m.withdrawn,
        profitCents: m.profit,
      })),
    },
    recentTransactions: recentTxns.all(req.user.id, 8).map(present.transaction),
    unreadNotifications: notify.unreadCount(req.user.id),
  });
}));

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
router.patch('/profile', sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  const data = check(req.body)
    .string('address_line', { required: false, max: 200, label: 'Address' })
    .string('city', { required: false, max: 80, label: 'City' })
    .string('country', { required: false, max: 2, min: 2, label: 'Country code' })
    .string('occupation', { required: false, max: 80, label: 'Occupation' })
    .isoDate('date_of_birth', { required: false, label: 'Date of birth', notFuture: true })
    .done();

  const before = profileStmt.get(req.user.id) || {};
  db.prepare(`
    UPDATE user_profiles SET
      address_line = COALESCE(?, address_line),
      city         = COALESCE(?, city),
      country      = COALESCE(?, country),
      occupation   = COALESCE(?, occupation),
      date_of_birth= COALESCE(?, date_of_birth),
      updated_at   = datetime('now')
    WHERE user_id = ?
  `).run(data.address_line, data.city, data.country?.toUpperCase(), data.occupation,
         data.date_of_birth ? data.date_of_birth.slice(0, 10) : null, req.user.id);

  const after = profileStmt.get(req.user.id);
  audit.record(req, {
    action: 'user.profile_updated', entityType: 'user', entityId: req.user.id,
    entityLabel: req.user.public_id,
    previous: { city: before.city, country: before.country },
    next: { city: after.city, country: after.country },
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
router.post('/password',
  sessionMw.requireCsrf,
  limit({ name: 'pwchange', max: 5, windowMs: 60 * 60 * 1000, keyBy: (req) => req.user.id }),
  asyncRoute(async (req, res) => {
    const v = check(req.body)
      .string('current_password', { max: 200, label: 'Current password' })
      .string('new_password', { min: 10, max: 200, label: 'New password' })
      .string('confirm_password', { max: 200, label: 'Password confirmation' });
    const problems = passwordProblems(req.body?.new_password);
    if (problems.length) v.custom('new_password', problems.join(' '), false);
    if (req.body?.new_password !== req.body?.confirm_password) {
      v.custom('confirm_password', 'The two passwords do not match.', false);
    }
    const data = v.done();

    if (!verifyPassword(data.current_password, req.user.password_hash)) {
      throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
        { current_password: 'That is not your current password.' });
    }
    if (verifyPassword(data.new_password, req.user.password_hash)) {
      throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
        { new_password: 'Choose a password you have not used on this account before.' });
    }

    db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(hashPassword(data.new_password), req.user.id);

    // Every other session is invalidated; this one is reissued.
    sessionMw.revokeAll('user', req.user.id);
    sessionMw.create(res, { principal: 'user', subjectId: req.user.id, req });

    audit.record(req, {
      action: 'user.password_changed', entityType: 'user', entityId: req.user.id, entityLabel: req.user.public_id,
    });
    notify.notify(req.user.id, {
      type: 'security.password_changed', severity: 'warning',
      title: 'Your password was changed',
      body: 'Your password was changed and all other sessions were signed out. If this was not you, contact support immediately.',
      link: '/app/#/security',
    });
    res.json({ ok: true });
  })
);

router.get('/sessions', asyncRoute(async (req, res) => {
  res.json({
    sessions: sessionMw.listFor('user', req.user.id).map((s) => ({
      id: s.id,
      current: s.id === req.session.id,
      ip: s.ip,
      device: s.user_agent,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      active: !s.revoked_at,
    })),
  });
}));

router.delete('/sessions/:id', sessionMw.requireCsrf, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw notFound('No such session.');
  if (id === req.session.id) {
    throw new AppError(400, 'bad_request', 'Use sign out to end the session you are currently using.');
  }
  const changes = sessionMw.revokeById(id, 'user', req.user.id);
  if (!changes) throw notFound('No such session.');
  audit.record(req, {
    action: 'user.session_revoked', entityType: 'user', entityId: req.user.id,
    entityLabel: req.user.public_id, next: { session_id: id },
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Account activity (a user-facing view of their own audit trail)
// ---------------------------------------------------------------------------
const activityStmt = db.prepare(`
  SELECT action, entity_type, entity_label, created_at, ip
  FROM audit_logs
  WHERE actor_type = 'user' AND actor_id = ?
  ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
`);
const activityCount = db.prepare(
  `SELECT COUNT(*) AS c FROM audit_logs WHERE actor_type = 'user' AND actor_id = ?`
);

const ACTIVITY_LABELS = {
  'user.registered': 'Account created',
  'user.login': 'Signed in',
  'user.logout': 'Signed out',
  'user.phone_verified': 'Mobile number verified',
  'user.otp_requested': 'Verification code requested',
  'user.otp_failed': 'Incorrect verification code',
  'user.password_changed': 'Password changed',
  'user.profile_updated': 'Profile updated',
  'user.session_revoked': 'Session signed out',
  'user.locked_out': 'Account temporarily locked',
  'deposit.submitted': 'Deposit submitted',
  'withdrawal.requested': 'Withdrawal requested',
  'withdrawal.cancelled': 'Withdrawal cancelled',
  'investment.opened': 'Investment opened',
  'kyc.submitted': 'Identity document submitted',
  'support.opened': 'Support request opened',
};

router.get('/activity', asyncRoute(async (req, res) => {
  const limitN = Math.min(Number(req.query.limit) || 25, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    total: activityCount.get(req.user.id).c,
    items: activityStmt.all(req.user.id, limitN, offset).map((row) => ({
      action: row.action,
      label: ACTIVITY_LABELS[row.action] || row.action.replace(/[._]/g, ' '),
      entity: row.entity_label,
      ip: row.ip,
      at: row.created_at,
    })),
  });
}));

module.exports = router;
