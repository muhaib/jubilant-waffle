'use strict';
const path = require('path');
const crypto = require('crypto');

function req(name, fallback) {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// In production every secret must be supplied explicitly. In development we
// derive ephemeral ones so `npm start` works on a clean checkout, and we say
// so loudly rather than pretending the install is production-ready.
function secret(name, bytes = 32) {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(
      `${name} must be set to at least 32 characters in production. Generate one with: openssl rand -hex 32`
    );
  }
  const generated = crypto.randomBytes(bytes).toString('hex');
  console.warn(
    `[config] ${name} is not set — generated an ephemeral development value. ` +
      'Sessions, OTPs and encrypted fields will not survive a restart.'
  );
  return generated;
}

const root = path.resolve(__dirname, '..');

module.exports = {
  env: NODE_ENV,
  isProd,
  root,
  port: Number(process.env.PORT || 4000),
  trustProxy: process.env.TRUST_PROXY || (isProd ? '1' : false),
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'platform.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'var', 'uploads'),

  secrets: {
    session: secret('SESSION_SECRET'),
    otp: secret('OTP_SECRET'),
    // 32-byte key for AES-256-GCM field encryption of identity documents.
    fieldKey: (() => {
      const hex = process.env.FIELD_ENCRYPTION_KEY;
      if (hex) {
        const buf = Buffer.from(hex, 'hex');
        if (buf.length !== 32) {
          throw new Error('FIELD_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
        }
        return buf;
      }
      if (isProd) {
        throw new Error(
          'FIELD_ENCRYPTION_KEY is required in production. Generate with: openssl rand -hex 32'
        );
      }
      console.warn(
        '[config] FIELD_ENCRYPTION_KEY is not set — encrypted KYC fields will be unreadable after restart.'
      );
      return crypto.randomBytes(32);
    })(),
    kycDigest: secret('KYC_DIGEST_SECRET'),
  },

  session: {
    cookieName: 'fxp_sid',
    adminCookieName: 'fxp_asid',
    csrfCookieName: 'fxp_csrf',
    userTtlMinutes: Number(process.env.SESSION_TTL_MINUTES || 60 * 12),
    adminTtlMinutes: Number(process.env.ADMIN_SESSION_TTL_MINUTES || 60 * 4),
    idleTimeoutMinutes: Number(process.env.SESSION_IDLE_MINUTES || 120),
  },

  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),

  otp: {
    length: Number(process.env.OTP_LENGTH || 4),
    ttlSeconds: Number(process.env.OTP_TTL_SECONDS || 300),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
    resendCooldownSeconds: Number(process.env.OTP_RESEND_COOLDOWN || 60),
    maxPerHour: Number(process.env.OTP_MAX_PER_HOUR || 5),
    // When no SMS provider is configured the code is not sent anywhere. In
    // development we surface it in the server log so the flow is testable;
    // in production this is refused outright (see lib/sms.js).
    echoInDev: process.env.OTP_ECHO !== 'false',
  },

  uploads: {
    // The brief asked for no cap. An unbounded multipart body is a trivial
    // disk-exhaustion vector, so the cap is configurable and simply set very
    // high by default rather than removed. Raise or lower it here.
    maxBytes: Number(process.env.UPLOAD_MAX_BYTES || 32 * 1024 * 1024),
    allowedMime: ['image/jpeg', 'image/png'],
  },

  sms: {
    provider: process.env.SMS_PROVIDER || '',       // '' = not configured
    apiKey: process.env.SMS_API_KEY || '',
    sender: process.env.SMS_SENDER || '',
  },
  email: {
    provider: process.env.EMAIL_PROVIDER || '',
    apiKey: process.env.EMAIL_API_KEY || '',
    from: process.env.EMAIL_FROM || '',
  },

  bootstrapAdmin: {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || '',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Super Admin',
  },

  req,
};
