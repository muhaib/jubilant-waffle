'use strict';
const crypto = require('crypto');

// Crockford-style alphabet: no I, L, O or U, so a reference read aloud over
// the phone to support cannot be transcribed ambiguously.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Cryptographically uniform random string over ALPHABET (no modulo bias). */
function randomCode(length) {
  const out = [];
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < max) out.push(ALPHABET[byte % ALPHABET.length]);
  }
  return out.join('');
}

/**
 * Generate a prefixed public reference, retrying on the (vanishingly rare)
 * collision. `exists` is a predicate against the relevant table.
 */
function uniqueRef(prefix, length, exists) {
  for (let i = 0; i < 12; i += 1) {
    const candidate = `${prefix}-${randomCode(length)}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a unique ${prefix} reference after 12 attempts`);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { ALPHABET, randomCode, uniqueRef, randomToken };
