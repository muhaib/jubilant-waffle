'use strict';

/**
 * All money in this system is an integer number of cents. These helpers are
 * the only sanctioned way in or out of that representation — nothing else
 * should be doing `* 100` on a float.
 */

const CENTS_RE = /^\d{1,12}(\.\d{1,2})?$/;

/** Parse user input ("1,250.50") to integer cents, or null if unparseable. */
function parseToCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    input = input.toFixed(2);
  }
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/[,\s$]/g, '');
  if (!CENTS_RE.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 123456 -> "1,234.56" */
function formatCents(cents, { withSymbol = false, currency = 'USD' } = {}) {
  const n = Number(cents || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  const symbol = withSymbol ? (currency === 'USD' ? '$' : `${currency} `) : '';
  return `${sign}${symbol}${whole}.${frac}`;
}

/**
 * The platform's illustrative calculation model.
 *
 * It is a fixed arithmetic model chosen by the operator — divisor and cycle
 * length — NOT a forecast of forex performance. Daily and cycle figures are
 * each derived from the principal independently so the cycle figure is not
 * the accumulated rounding error of the daily one.
 */
function illustrate(principalCents, { divisor, cycleDays }) {
  if (!Number.isInteger(principalCents) || principalCents <= 0) {
    throw new Error('principalCents must be a positive integer');
  }
  if (!divisor || divisor <= 0 || !cycleDays || cycleDays <= 0) {
    throw new Error('Illustrative model parameters are invalid');
  }
  return {
    dailyCents: Math.round(principalCents / divisor),
    cycleCents: Math.round((principalCents * cycleDays) / divisor),
    divisor,
    cycleDays,
  };
}

module.exports = { parseToCents, formatCents, illustrate };
