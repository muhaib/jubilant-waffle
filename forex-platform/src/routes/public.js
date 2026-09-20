'use strict';
const express = require('express');
const { db } = require('../db');
const settings = require('../lib/settings');
const money = require('../lib/money');
const phoneLib = require('../lib/phone');
const { check } = require('../lib/validate');
const { limit, asyncRoute } = require('../middleware/common');
const { notFound } = require('../lib/errors');

const router = express.Router();

const contentStmt = db.prepare('SELECT * FROM content_blocks WHERE key = ?');
const allContent = db.prepare('SELECT key, title, body, updated_at FROM content_blocks');

/**
 * Everything the public site needs to render, resolved from the database so
 * an administrator can change copy, limits, contact numbers and the
 * illustrative model without a deploy.
 */
router.get('/config', (req, res) => {
  const limits = settings.investmentLimits();
  const model = settings.illustrativeModel();
  const whatsapp = settings.get('support_whatsapp', '');
  const content = {};
  for (const row of allContent.all()) content[row.key] = row.body;

  res.json({
    platformName: settings.get('platform_name', 'Platform'),
    registrationEnabled: settings.get('registration_enabled', true),
    maintenanceMode: settings.get('maintenance_mode', false),
    investment: {
      minCents: limits.minCents,
      maxCents: limits.maxCents,
      model,
      disclaimer: settings.get('illus_disclaimer', ''),
    },
    support: {
      whatsappDisplay: phoneLib.formatLocal(phoneLib.normalisePk(whatsapp) || whatsapp) || whatsapp,
      whatsappDigits: phoneLib.toWhatsappDigits(whatsapp),
      hours: settings.get('support_hours', ''),
      email: settings.get('support_email', '') || null,
    },
    deposits: { enabled: settings.get('deposits_enabled', true) },
    withdrawals: {
      enabled: settings.get('withdrawals_enabled', true),
      minCents: settings.get('withdrawal_min_cents', 1000),
      feeBps: settings.get('withdrawal_fee_bps', 0),
      rules: settings.get('withdrawal_rules', ''),
      whatsappEnabled: settings.get('withdrawal_whatsapp_enabled', true),
    },
    content: {
      heroHeadline: content.hero_headline,
      heroSubhead: content.hero_subhead,
      whyPlatform: safeJson(content.why_platform, []),
      howItWorksNote: content.how_it_works_note,
    },
  });
});

function safeJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

router.get('/content/:key', (req, res, next) => {
  const row = contentStmt.get(req.params.key);
  if (!row) return next(notFound('That page does not exist.'));
  res.json({ key: row.key, title: row.title, body: row.body, updatedAt: row.updated_at });
});

/**
 * The illustrative calculator.
 *
 * Deliberately server-side: the model parameters live in the database, the
 * limits are enforced here, and the browser never decides what a figure is.
 * The client redraws instantly from the same parameters for responsiveness,
 * but this endpoint is the authority and is what an investment is opened from.
 */
router.post('/calculator',
  limit({ name: 'calc', max: 120, windowMs: 60 * 1000 }),
  asyncRoute(async (req, res) => {
    const { amount } = check(req.body).string('amount', { max: 20, label: 'Investment amount' }).done();
    const cents = money.parseToCents(amount);
    const limits = settings.investmentLimits();

    if (cents === null) {
      return res.status(422).json({
        error: { code: 'validation_failed', message: 'Enter an amount.', fields: { amount: 'Enter an amount such as 250 or 1,000.50.' } },
      });
    }
    const problems = [];
    if (cents < limits.minCents) problems.push(`The minimum investment is ${money.formatCents(limits.minCents, { withSymbol: true })}.`);
    if (cents > limits.maxCents) problems.push(`The maximum investment is ${money.formatCents(limits.maxCents, { withSymbol: true })}.`);

    const model = settings.illustrativeModel();
    const figures = money.illustrate(Math.max(cents, 1), model);

    res.json({
      amountCents: cents,
      withinLimits: problems.length === 0,
      problems,
      illustrative: {
        dailyCents: figures.dailyCents,
        cycleCents: figures.cycleCents,
        divisor: model.divisor,
        cycleDays: model.cycleDays,
      },
      disclaimer: settings.get('illus_disclaimer', ''),
    });
  })
);

/**
 * The worked example table, generated from the model in force rather than
 * hard-coded, so it can never drift from what the calculator produces.
 */
router.get('/illustration-table', (req, res) => {
  const model = settings.illustrativeModel();
  const limits = settings.investmentLimits();
  const tiers = [3000, 5000, 10000, 50000, 100000, 200000, 500000, 1000000]
    .filter((c) => c >= limits.minCents && c <= limits.maxCents);
  res.json({
    model,
    disclaimer: settings.get('illus_disclaimer', ''),
    rows: tiers.map((principalCents) => {
      const f = money.illustrate(principalCents, model);
      return { principalCents, dailyCents: f.dailyCents, cycleCents: f.cycleCents };
    }),
  });
});

module.exports = router;
