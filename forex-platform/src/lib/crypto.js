'use strict';
const crypto = require('crypto');
const config = require('../config');

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
function encryptField(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.secrets.fieldKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

function decryptField(packed) {
  const [version, ivB64, tagB64, ctB64] = String(packed).split('.');
  if (version !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    config.secrets.fieldKey,
    Buffer.from(ivB64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Keyed digest used for equality lookups on data we never want to decrypt. */
function keyedDigest(value, secret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still burn a comparison so timing does not leak length.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { encryptField, decryptField, keyedDigest, sha256, safeEqual };
