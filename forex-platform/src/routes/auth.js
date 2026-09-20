'use strict';
const express = require('express');
const config = require('../config');
const { db, tx } = require('../db');
const { check } = require('../lib/validate');
const { uniqueRef } = require('../lib/ids');
const { hashPassword, verifyPassword, passwordProblems } = require('../lib/password');
const phoneLib = require('../lib/phone');
const otp = require('../lib/otp');
const sms = require('../lib/sms');
const risk = require('../lib/risk');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const settings = require('../lib/settings');
const present = require('../lib/present');
const session = require('../middleware/session');
const { attachUser, requireUser } = require('../middleware/auth');
const { limit, asyncRoute } = require('../middleware/common');
const { AppError, bad, conflict, forbidden, unauth } = require('../lib/errors');

const router = express.Router();

const byEmail = db.prepare('SELECT * FROM users WHERE email_normalized = ?');
const byPhone = db.prepare('SELECT * FROM users WHERE phone_e164 = ?');
const byId = db.prepare('SELECT * FROM users WHERE id = ?');
const publicIdExists = db.prepare('SELECT 1 FROM users WHERE public_id = ?');

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

function deviceFrom(body) {
  const d = body?.device;
  if (!d || typeof d !== 'object' || !d.hash) return null;
  return {
    hash: String(d.hash).slice(0, 128),
    platform: d.platform, screen: d.screen, timezone: d.timezone, languages: d.languages,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
router.post('/register',
  limit({ name: 'register:ip', max: 5, windowMs: 60 * 60 * 1000,
    message: 'Too many accounts have been created from this network recently. Try again later.' }),
  asyncRoute(async (req, res) => {
    if (!settings.get('registration_enabled', true)) {
      throw new AppError(503, 'registration_closed', 'New registrations are temporarily closed.');
    }
    // Phone verification is mandatory, so registration cannot honestly proceed
    // in production without a way to deliver the code.
    if (config.isProd && !sms.isConfigured()) {
      throw new AppError(503, 'sms_unavailable',
        'Phone verification is temporarily unavailable. Please try again shortly.');
    }

    const v = check(req.body)
      .string('full_name', { min: 2, max: 120, label: 'Full name' })
      .email('email')
      .string('phone', { label: 'Mobile number', max: 30 })
      .string('password', { min: 10, max: 200, label: 'Password' })
      .string('confirm_password', { min: 1, max: 200, label: 'Password confirmation' })
      .string('cnic', { required: false, max: 20, label: 'CNIC' })
      .bool('accept_terms', { mustBeTrue: true, label: 'The terms and conditions' })
      .bool('accept_risk', { mustBeTrue: true, label: 'The risk disclosure' });

    const pwProblems = passwordProblems(req.body?.password);
    if (pwProblems.length) v.custom('password', pwProblems.join(' '), false);
    if (req.body?.password !== req.body?.confirm_password) {
      v.custom('confirm_password', 'The two passwords do not match.', false);
    }
    const e164 = phoneLib.normalisePk(req.body?.phone);
    if (!e164) v.custom('phone', 'Enter a valid Pakistani mobile number, for example 0300 1234567.', false);

    const data = v.done();

    if (byEmail.get(data.email)) {
      throw conflict('An account already exists with that email address.', { email: 'An account already exists with that email address.' });
    }
    if (byPhone.get(e164)) {
      throw conflict('An account already exists with that mobile number.', { phone: 'An account already exists with that mobile number.' });
    }

    let cnicPayload = null;
    if (data.cnic) {
      const digits = data.cnic.replace(/\D/g, '');
      if (digits.length !== 13) {
        throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
          { cnic: 'A CNIC is 13 digits, for example 42101-1234567-3.' });
      }
      if (!req.body?.cnic_consent) {
        throw new AppError(422, 'validation_failed', 'Please correct the highlighted fields.',
          { cnic_consent: 'Tick the consent box to submit your CNIC, or leave the CNIC field empty.' });
      }
      cnicPayload = { digits };
    }

    const publicId = uniqueRef('USR', 6, (c) => !!publicIdExists.get(c));
    const termsVersion = settings.get('terms_version', '1');

    const created = tx(() => {
      const info = db.prepare(`
        INSERT INTO users (public_id, full_name, email, email_normalized, phone_e164, password_hash,
                           status, terms_accepted_at, risk_ack_at, terms_version, signup_ip)
        VALUES (?,?,?,?,?,?, 'verification_required', datetime('now'), datetime('now'), ?, ?)
      `).run(publicId, data.full_name, req.body.email.trim(), data.email, e164,
             hashPassword(data.password), termsVersion, req.clientIp || null);
      const userId = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO user_profiles (user_id) VALUES (?)').run(userId);
      return userId;
    })();

    const userRow = byId.get(created);
    req.actor = { type: 'user', id: created, label: publicId, role: 'user' };

    audit.record(req, {
      action: 'user.registered',
      entityType: 'user', entityId: created, entityLabel: publicId,
      next: { email: data.email, phone: e164 },
    });
    audit.status(req, { entityType: 'user', entityId: created, from: null, to: 'verification_required' });

    if (cnicPayload) {
      // Stored encrypted; the duplicate check works on a keyed digest so the
      // ciphertext never needs to be decrypted to spot a repeat submission.
      const { encryptField, keyedDigest } = require('../lib/crypto');
      const digest = keyedDigest(cnicPayload.digits, config.secrets.kycDigest);
      db.prepare(`
        INSERT INTO kyc_records (user_id, doc_type, id_ciphertext, id_digest, id_prefix, id_last,
                                 full_name_on_id, consent_at, consent_version, purpose_note, retention_until)
        VALUES (?, 'cnic', ?, ?, ?, ?, ?, datetime('now'), ?, ?, datetime('now', ?))
      `).run(created, encryptField(cnicPayload.digits), digest,
             cnicPayload.digits.slice(0, 5), cnicPayload.digits.slice(-1), data.full_name,
             termsVersion, settings.get('kyc_purpose_note', ''),
             `+${settings.get('kyc_retention_months', 60)} months`);
      audit.record(req, {
        action: 'kyc.submitted', entityType: 'user', entityId: created, entityLabel: publicId,
        next: { doc_type: 'cnic', masked: present.maskIdentityNumber(cnicPayload.digits.slice(0, 5), cnicPayload.digits.slice(-1)) },
        reason: 'Submitted at registration with explicit consent',
      });
      if (settings.get('duplicate_review_enabled', true)) {
        risk.checkKycDuplicate(req, created, digest);
      }
    }

    if (settings.get('duplicate_review_enabled', true)) {
      risk.recordDevice(req, created, deviceFrom(req.body));
    }

    notify.notify(created, {
      type: 'account.registered',
      severity: 'info',
      title: 'Welcome to the platform',
      body: `Your account ${publicId} has been created. Verify your mobile number to activate it.`,
      link: '/app/#/verify',
    });

    session.create(res, { principal: 'user', subjectId: created, req });
    const issued = await otp.issue({ phone: e164, purpose: 'signup', userId: created, ip: req.clientIp });

    res.status(201).json({
      user: present.user(byId.get(created)),
      verification: {
        required: true,
        phoneMasked: phoneLib.maskLocal(e164),
        expiresInSeconds: issued.expiresInSeconds,
        delivery: issued.delivery.status,
        // Only ever populated outside production with no SMS provider wired up.
        developmentCode: issued.devCode,
      },
    });
  })
);

// ---------------------------------------------------------------------------
// Phone verification
// ---------------------------------------------------------------------------
router.post('/verify/request',
  attachUser, requireUser, session.requireCsrf,
  limit({ name: 'otp:req', max: 10, windowMs: 60 * 60 * 1000, keyBy: (req) => req.user.id }),
  asyncRoute(async (req, res) => {
    if (req.user.phone_verified_at) return res.json({ alreadyVerified: true });
    const issued = await otp.issue({
      phone: req.user.phone_e164, purpose: 'signup', userId: req.user.id, ip: req.clientIp,
    });
    audit.record(req, { action: 'user.otp_requested', entityType: 'user', entityId: req.user.id, entityLabel: req.user.public_id });
    res.json({
      phoneMasked: phoneLib.maskLocal(req.user.phone_e164),
      expiresInSeconds: issued.expiresInSeconds,
      delivery: issued.delivery.status,
      developmentCode: issued.devCode,
    });
  })
);

router.post('/verify/confirm',
  attachUser, requireUser, session.requireCsrf,
  limit({ name: 'otp:confirm', max: 20, windowMs: 10 * 60 * 1000, keyBy: (req) => req.user.id }),
  asyncRoute(async (req, res) => {
    if (req.user.phone_verified_at) return res.json({ alreadyVerified: true, user: present.user(req.user) });
    const { code } = check(req.body)
      .string('code', { min: 3, max: 8, label: 'Verification code' })
      .done();

    const result = otp.verify({
      phone: req.user.phone_e164, purpose: 'signup', code, ip: req.clientIp,
    });

    if (!result.ok) {
      const messages = {
        no_code: 'No active code for this number. Request a new one.',
        expired: 'That code has expired. Request a new one.',
        locked: 'Too many incorrect attempts. Request a new code.',
        mismatch: result.attemptsLeft > 0
          ? `That code is not correct. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} remaining.`
          : 'That code is not correct and no attempts remain. Request a new code.',
      };
      audit.record(req, {
        action: 'user.otp_failed', entityType: 'user', entityId: req.user.id,
        entityLabel: req.user.public_id, next: { reason: result.reason },
      });
      throw new AppError(422, 'otp_invalid', messages[result.reason], { code: messages[result.reason] });
    }

    tx(() => {
      db.prepare(`
        UPDATE users SET phone_verified_at = datetime('now'),
          status = CASE WHEN status = 'verification_required' THEN 'normal' ELSE status END,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(req.user.id);
    })();

    const updated = byId.get(req.user.id);
    audit.record(req, {
      action: 'user.phone_verified', entityType: 'user', entityId: req.user.id,
      entityLabel: req.user.public_id, previous: req.user.status, next: updated.status,
    });
    audit.status(req, {
      entityType: 'user', entityId: req.user.id, from: req.user.status, to: updated.status,
      note: 'Mobile number verified',
    });
    notify.notify(req.user.id, {
      type: 'account.phone_verified', severity: 'success',
      title: 'Mobile number verified',
      body: 'Your mobile number is verified. Your account is now active.',
      link: '/app/',
    });

    res.json({ verified: true, user: present.user(updated) });
  })
);

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------
router.post('/login',
  limit({ name: 'login:ip', max: 20, windowMs: 15 * 60 * 1000,
    message: 'Too many sign-in attempts from this network. Try again in a few minutes.' }),
  limit({ name: 'login:id', max: 8, windowMs: 15 * 60 * 1000,
    keyBy: (req) => String(req.body?.identifier || '').toLowerCase().slice(0, 80),
    message: 'Too many sign-in attempts for this account. Try again in a few minutes.' }),
  asyncRoute(async (req, res) => {
    const { identifier, password } = check(req.body)
      .string('identifier', { max: 254, label: 'Email or mobile number' })
      .string('password', { max: 200, label: 'Password' })
      .done();

    const e164 = phoneLib.normalisePk(identifier);
    const user = e164 ? byPhone.get(e164) : byEmail.get(identifier.toLowerCase());

    // One message for every failure mode, so the response cannot be used to
    // enumerate which email addresses or numbers are registered.
    const generic = unauth('Those sign-in details are not correct.');

    if (!user) {
      verifyPassword(password, null);
      throw generic;
    }
    if (user.locked_until && db.prepare(`SELECT datetime('now') < ? AS locked`).get(user.locked_until).locked === 1) {
      throw new AppError(429, 'account_locked',
        'This account is temporarily locked after repeated failed sign-ins. Try again shortly or contact support.');
    }
    if (!verifyPassword(password, user.password_hash)) {
      const failures = user.failed_logins + 1;
      if (failures >= LOCKOUT_THRESHOLD) {
        db.prepare(`UPDATE users SET failed_logins = ?, locked_until = datetime('now', ?) WHERE id = ?`)
          .run(failures, `+${LOCKOUT_MINUTES} minutes`, user.id);
        audit.record(req, {
          action: 'user.locked_out', entityType: 'user', entityId: user.id, entityLabel: user.public_id,
          reason: `${failures} consecutive failed sign-in attempts`,
          actor: { type: 'system', id: null, label: 'auth' },
        });
        notify.notify(user.id, {
          type: 'security.lockout', severity: 'warning',
          title: 'Account temporarily locked',
          body: `Your account was locked for ${LOCKOUT_MINUTES} minutes after repeated failed sign-in attempts. If this was not you, change your password.`,
          link: '/app/#/security',
        });
      } else {
        db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failures, user.id);
      }
      throw generic;
    }
    if (user.status === 'banned') {
      throw forbidden('This account has been closed. Contact support if you believe this is a mistake.');
    }

    db.prepare(`
      UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?
    `).run(user.id);

    req.actor = { type: 'user', id: user.id, label: user.public_id, role: 'user' };
    session.create(res, { principal: 'user', subjectId: user.id, req });

    if (settings.get('duplicate_review_enabled', true)) {
      risk.recordDevice(req, user.id, deviceFrom(req.body));
    }
    audit.record(req, { action: 'user.login', entityType: 'user', entityId: user.id, entityLabel: user.public_id });

    const fresh = byId.get(user.id);
    res.json({
      user: present.user(fresh),
      next: fresh.phone_verified_at ? 'dashboard' : 'verify',
    });
  })
);

router.post('/logout', attachUser, asyncRoute(async (req, res) => {
  if (req.user) {
    audit.record(req, { action: 'user.logout', entityType: 'user', entityId: req.user.id, entityLabel: req.user.public_id });
  }
  session.destroy(req, res, 'user');
  res.json({ ok: true });
}));

router.get('/session', attachUser, (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    user: present.user(req.user),
    next: req.user.phone_verified_at ? 'dashboard' : 'verify',
  });
});

module.exports = router;
