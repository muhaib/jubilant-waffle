'use strict';

/**
 * Normalise Pakistani mobile numbers to E.164. Accepts the local formats
 * people actually type (03xx-xxxxxxx, 3xxxxxxxxx, +92 3xx ...) and rejects
 * anything that is not a plausible mobile number.
 *
 * Returns null when the input cannot be normalised — callers surface a field
 * error rather than storing an unusable number.
 */
function normalisePk(input) {
  if (typeof input !== 'string') return null;
  let d = input.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  // A Pakistani mobile subscriber number is 3XXXXXXXXX (10 digits).
  if (!/^3\d{9}$/.test(d)) return null;
  return `+92${d}`;
}

/** +923001234567 -> 0300 1234567 (what the user recognises). */
function formatLocal(e164) {
  const m = /^\+92(3\d{2})(\d{7})$/.exec(e164 || '');
  if (!m) return e164 || '';
  return `0${m[1]} ${m[2]}`;
}

/** +923001234567 -> 0300 ***4567, for screens that do not need the full number. */
function maskLocal(e164) {
  const m = /^\+92(3\d{2})(\d{3})(\d{4})$/.exec(e164 || '');
  if (!m) return '••••';
  return `0${m[1]} •••${m[3]}`;
}

/** WhatsApp deep links need the digits with no plus. */
function toWhatsappDigits(input) {
  const e164 = normalisePk(input) || String(input || '');
  return e164.replace(/[^\d]/g, '');
}

module.exports = { normalisePk, formatLocal, maskLocal, toWhatsappDigits };
