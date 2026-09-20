'use strict';
const bcrypt = require('bcryptjs');
const config = require('../config');

/**
 * bcrypt at cost 12. The brief allowed Argon2id or bcrypt; bcrypt is used
 * because it needs no native toolchain at install time. To move to Argon2id,
 * swap the two functions below and re-hash lazily on next successful login
 * (hashes are self-describing, so both can coexist during the migration).
 */
function hashPassword(plain) {
  return bcrypt.hashSync(plain, config.bcryptRounds);
}

function verifyPassword(plain, hash) {
  if (!hash) {
    // Keep the timing profile of a real verification for unknown accounts.
    bcrypt.compareSync(plain, '$2a$12$abcdefghijklmnopqrstuuKjO8LsO.PoZFqBqC6bYyAQeVWOxGRa');
    return false;
  }
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

/** Returns an array of human-readable problems; empty means acceptable. */
function passwordProblems(pw) {
  const problems = [];
  if (typeof pw !== 'string' || pw.length < 10) problems.push('Use at least 10 characters.');
  if (pw && pw.length > 200) problems.push('Use no more than 200 characters.');
  if (!/[a-z]/.test(pw || '')) problems.push('Include a lowercase letter.');
  if (!/[A-Z]/.test(pw || '')) problems.push('Include an uppercase letter.');
  if (!/\d/.test(pw || '')) problems.push('Include a number.');
  return problems;
}

module.exports = { hashPassword, verifyPassword, passwordProblems };
