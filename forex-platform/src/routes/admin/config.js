'use strict';
const express = require('express');
const { db } = require('../../db');
const settings = require('../../lib/settings');
const audit = require('../../lib/audit');
const money = require('../../lib/money');
const phoneLib = require('../../lib/phone');
const { check } = require('../../lib/validate');
const sessionMw = require('../../middleware/session');
const { requirePermission } = require('../../middleware/auth');
const { asyncRoute } = require('../../middleware/common');
const { AppError, notFound } = require('../../lib/errors');

const router = express.Router();

const GROUP_LABELS = {
  platform: 'Platform',
  investment: 'Investment programme',
  deposits: 'Deposits',
  withdrawals: 'Withdrawals',
  support: 'Support',
  compliance: 'Verification & risk',
  notifications: 'Notifications',
};

router.get('/settings', requirePermission('settings.view'), asyncRoute(async (req, res) => {
  const grouped = {};
  for (const row of settings.rows()) {
    (grouped[row.group_key] ||= []).push({
      key: row.key, value: row.value, parsed: row.parsed, type: row.value_type,
      label: row.label, help: row.help, updatedAt: row.updated_at,
    });
  }
  res.json({
    groups: Object.entries(grouped).map(([key, items]) => ({
      key, label: GROUP_LABELS[key] || key, items,
    })),
    canEdit: req.adminPermissions.has('settings.manage'),
  });
}));

/**
 * Validate a setting before it is stored. Configuration is as capable of
 * breaking the platform as code is, so the constraints live here rather than
 * relying on the form.
 */
function validateSetting(key, raw) {
  const row = db.prepare('SELECT * FROM platform_settings WHERE key = ?').get(key);
  if (!row) throw notFound(`Unknown setting: ${key}`);

  let value = String(raw ?? '').trim();
  const fail = (msg) => { throw new AppError(422, 'validation_failed', msg, { value: msg }); };

  switch (row.value_type) {
    case 'bool':
      value = (raw === true || raw === 'true' || raw === '1' || raw === 1) ? '1' : '0';
      break;
    case 'int': {
      if (!/^\d{1,9}$/.test(value)) fail('Enter a whole number.');
      const n = Number(value);
      if (key === 'illus_divisor' && n < 1) fail('The divisor must be at least 1.');
      if (key === 'illus_cycle_days' && (n < 1 || n > 31)) fail('The cycle length must be between 1 and 31 days.');
      if (key === 'withdrawal_fee_bps' && n > 2000) fail('A fee above 20% (2000 basis points) is not permitted from this screen.');
      if (key === 'kyc_retention_months' && (n < 1 || n > 240)) fail('Retention must be between 1 and 240 months.');
      break;
    }
    case 'money': {
      const cents = money.parseToCents(value);
      if (cents === null || cents < 0) fail('Enter an amount such as 30 or 10,000.');
      value = String(cents);
      break;
    }
    case 'string':
      if (value.length > 300) fail('Keep this under 300 characters.');
      if (key === 'support_whatsapp' && value && !phoneLib.normalisePk(value)) {
        fail('Enter a valid Pakistani mobile number, for example 0342 2253628.');
      }
      if (key === 'support_email' && value && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) {
        fail('Enter a valid email address, or leave it blank to hide the email contact.');
      }
      break;
    case 'text':
      if (value.length > 5000) fail('Keep this under 5000 characters.');
      break;
    default:
      break;
  }
  return { row, value };
}

router.put('/settings', requirePermission('settings.manage'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const data = check(req.body)
      .string('key', { max: 80, label: 'Setting key' })
      .string('reason', { required: false, max: 300, label: 'Reason' })
      .done();

    const { row, value } = validateSetting(data.key, req.body?.value);

    // Cross-field constraints that a single setting cannot check alone.
    if (data.key === 'min_investment_cents' && Number(value) > settings.get('max_investment_cents', Infinity)) {
      throw new AppError(422, 'validation_failed', 'The minimum cannot be above the maximum investment.',
        { value: 'The minimum cannot be above the maximum investment.' });
    }
    if (data.key === 'max_investment_cents' && Number(value) < settings.get('min_investment_cents', 0)) {
      throw new AppError(422, 'validation_failed', 'The maximum cannot be below the minimum investment.',
        { value: 'The maximum cannot be below the minimum investment.' });
    }

    const result = settings.set(data.key, value, req.admin.id, data.reason);
    if (result.previous !== result.next) {
      audit.record(req, {
        action: 'settings.changed', entityType: 'setting', entityLabel: data.key,
        previous: result.previous, next: result.next, reason: data.reason,
      });
    }
    res.json({ ok: true, key: data.key, value: result.next, changed: result.previous !== result.next, label: row.label });
  })
);

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------
router.get('/content', requirePermission('settings.view'), asyncRoute(async (req, res) => {
  res.json({
    canEdit: req.adminPermissions.has('content.manage'),
    items: db.prepare('SELECT key, title, body, updated_at FROM content_blocks ORDER BY key').all()
      .map((c) => ({ key: c.key, title: c.title, body: c.body, updatedAt: c.updated_at })),
  });
}));

router.put('/content/:key', requirePermission('content.manage'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const existing = db.prepare('SELECT * FROM content_blocks WHERE key = ?').get(req.params.key);
    if (!existing) throw notFound('No such content block.');
    const data = check(req.body)
      .string('body', { min: 1, max: 20000, label: 'Content' })
      .string('reason', { required: false, max: 300, label: 'Reason' })
      .done();

    db.prepare(`UPDATE content_blocks SET body = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`)
      .run(data.body, req.admin.id, req.params.key);
    audit.record(req, {
      action: 'content.changed', entityType: 'content_block', entityLabel: req.params.key,
      previous: existing.body.slice(0, 2000), next: data.body.slice(0, 2000), reason: data.reason,
    });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------
router.get('/payment-methods', requirePermission('settings.view'), asyncRoute(async (req, res) => {
  res.json({
    canEdit: req.adminPermissions.has('payments.manage'),
    items: db.prepare('SELECT * FROM payment_methods ORDER BY sort_order, name').all().map((m) => ({
      id: m.id, key: m.key, name: m.name, provider: m.provider,
      accountTitle: m.account_title, accountNumber: m.account_number, instructions: m.instructions,
      forDeposit: Boolean(m.for_deposit), forWithdrawal: Boolean(m.for_withdrawal),
      isActive: Boolean(m.is_active), sortOrder: m.sort_order, updatedAt: m.updated_at,
    })),
  });
}));

router.put('/payment-methods/:id', requirePermission('payments.manage'), sessionMw.requireCsrf,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id);
    if (!existing) throw notFound('No such payment method.');

    const v = check(req.body)
      .string('name', { min: 2, max: 80, label: 'Name' })
      .string('account_title', { required: false, max: 120, label: 'Account title' })
      .string('account_number', { required: false, max: 40, label: 'Account number' })
      .string('instructions', { required: false, max: 2000, label: 'Instructions' })
      .bool('for_deposit').bool('for_withdrawal').bool('is_active')
      .string('reason', { required: false, max: 300, label: 'Reason' });
    const data = v.done();

    // A method cannot be switched on without somewhere for the money to go.
    if (data.is_active && data.for_deposit && !data.account_number) {
      throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
        { account_number: 'Set the receiving account number before enabling this method for deposits.' });
    }

    db.prepare(`
      UPDATE payment_methods SET name = ?, account_title = ?, account_number = ?, instructions = ?,
        for_deposit = ?, for_withdrawal = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?
    `).run(data.name, data.account_title, data.account_number, data.instructions,
           data.for_deposit ? 1 : 0, data.for_withdrawal ? 1 : 0, data.is_active ? 1 : 0, id);

    audit.record(req, {
      action: 'payment_method.changed', entityType: 'payment_method', entityId: id, entityLabel: existing.key,
      previous: {
        name: existing.name, account_number: existing.account_number,
        account_title: existing.account_title, is_active: Boolean(existing.is_active),
      },
      next: {
        name: data.name, account_number: data.account_number,
        account_title: data.account_title, is_active: data.is_active,
      },
      reason: data.reason,
    });
    res.json({ ok: true });
  })
);

module.exports = router;
