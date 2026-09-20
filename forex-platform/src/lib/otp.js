'use strict';
const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db');
const { keyedDigest, safeEqual } = require('./crypto');
const rateLimit = require('./ratelimit');
const sms = require('./sms');
const { tooMany, bad } = require('./errors');

/**
 * Phone verification.
 *
 * The plaintext code exists only inside this module for the duration of the
 * request that creates it. What is persisted is an HMAC-SHA256 digest keyed
 * with OTP_SECRET, so a database copy alone cannot be used to verify a code.
 * Verification, expiry and attempt counting all happen server-side.
 */

const DIGITS = '0123456789';

function generateCode(length = config.otp.length) {
  // Rejection sampling keeps every digit equally likely.
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 250) out += DIGITS[byte % 10];
  }
  return out;
}

function digestFor(phone, purpose, code) {
  return keyedDigest(`${phone}|${purpose}|${code}`, config.secrets.otp);
}

const invalidatePrevious = db.prepare(`
  UPDATE phone_verifications SET invalidated_at = datetime('now')
  WHERE phone_e164 = ? AND purpose = ? AND consumed_at IS NULL AND invalidated_at IS NULL
`);

const insertOtp = db.prepare(`
  INSERT INTO phone_verifications (user_id, phone_e164, purpose, code_digest, max_attempts, expires_at, request_ip)
  VALUES (?,?,?,?,?, datetime('now', ?), ?)
`);

const latestOtp = db.prepare(`
  SELECT * FROM phone_verifications
  WHERE phone_e164 = ? AND purpose = ? AND consumed_at IS NULL AND invalidated_at IS NULL
  ORDER BY id DESC LIMIT 1
`);

const bumpAttempts = db.prepare('UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = ?');
const consume = db.prepare(`UPDATE phone_verifications SET consumed_at = datetime('now') WHERE id = ?`);

/**
 * Issue a code. Throttled twice: a short cooldown between requests, and an
 * hourly ceiling per phone number and per source IP.
 */
async function issue({ phone, purpose, userId = null, ip = null }) {
  const cooldown = rateLimit.consume(
    `otp:cooldown:${phone}:${purpose}`, 1, config.otp.resendCooldownSeconds * 1000
  );
  if (!cooldown.ok) {
    throw tooMany(
      `Please wait ${cooldown.retryAfter} second${cooldown.retryAfter === 1 ? '' : 's'} before requesting another code.`,
      cooldown.retryAfter
    );
  }
  const hourly = rateLimit.consume(`otp:hourly:${phone}`, config.otp.maxPerHour, 3600_000);
  if (!hourly.ok) {
    throw tooMany('Too many verification codes requested for this number. Try again later.', hourly.retryAfter);
  }
  if (ip) {
    const byIp = rateLimit.consume(`otp:ip:${ip}`, config.otp.maxPerHour * 4, 3600_000);
    if (!byIp.ok) throw tooMany('Too many verification requests from this network. Try again later.', byIp.retryAfter);
  }

  const code = generateCode();
  invalidatePrevious.run(phone, purpose);
  const info = insertOtp.run(
    userId, phone, purpose, digestFor(phone, purpose, code),
    config.otp.maxAttempts, `+${config.otp.ttlSeconds} seconds`, ip
  );

  const delivery = await sms.send(phone, `Your verification code is ${code}. It expires in ${Math.round(config.otp.ttlSeconds / 60)} minutes. Do not share it with anyone.`);

  // With no SMS provider configured the code cannot reach the user. Surfacing
  // it in the development log is the only way the flow is testable; in
  // production this branch is never taken because the code refuses to start
  // a real signup flow without a provider (see routes/auth).
  let devCode = null;
  if (delivery.status === 'skipped_not_configured' && !config.isProd && config.otp.echoInDev) {
    devCode = code;
    console.warn(`[otp] No SMS provider configured. Code for ${phone} (${purpose}) is ${code}`);
  }

  return {
    id: Number(info.lastInsertRowid),
    expiresInSeconds: config.otp.ttlSeconds,
    delivery,
    devCode,
  };
}

/**
 * Verify a submitted code.
 * @returns {{ok: true, record: object} | {ok: false, reason: string, attemptsLeft: number}}
 */
function verify({ phone, purpose, code, ip = null }) {
  if (ip) {
    const attempt = rateLimit.consume(`otp:verify:${ip}`, 20, 600_000);
    if (!attempt.ok) throw tooMany('Too many verification attempts. Try again shortly.', attempt.retryAfter);
  }
  const brute = rateLimit.consume(`otp:verify:${phone}`, 10, 600_000);
  if (!brute.ok) throw tooMany('Too many verification attempts for this number. Try again shortly.', brute.retryAfter);

  const row = latestOtp.get(phone, purpose);
  if (!row) return { ok: false, reason: 'no_code', attemptsLeft: 0 };

  const expired = db.prepare(`SELECT datetime('now') > ? AS expired`).get(row.expires_at).expired === 1;
  if (expired) return { ok: false, reason: 'expired', attemptsLeft: 0 };
  if (row.attempts >= row.max_attempts) return { ok: false, reason: 'locked', attemptsLeft: 0 };

  bumpAttempts.run(row.id);
  const submitted = String(code || '').trim();
  if (!/^\d+$/.test(submitted) || !safeEqual(digestFor(phone, purpose, submitted), row.code_digest)) {
    const left = Math.max(0, row.max_attempts - (row.attempts + 1));
    return { ok: false, reason: 'mismatch', attemptsLeft: left };
  }
  consume.run(row.id);
  return { ok: true, record: row };
}

module.exports = { issue, verify, generateCode };
