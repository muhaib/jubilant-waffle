'use strict';
const { invalid } = require('./errors');

/**
 * Small, explicit validator. Every route declares the exact shape it accepts
 * and unknown keys are dropped — a client can never smuggle in a field the
 * route did not ask for (balance, status, role, ...).
 */
class Check {
  constructor(body) {
    this.body = body && typeof body === 'object' ? body : {};
    this.out = {};
    this.errors = {};
  }

  _fail(field, message) {
    if (!this.errors[field]) this.errors[field] = message;
    return this;
  }

  raw(field) { return this.body[field]; }

  string(field, { required = true, min = 1, max = 255, label, pattern, patternMessage, trim = true } = {}) {
    const name = label || field;
    let v = this.body[field];
    if (v === undefined || v === null) v = '';
    if (typeof v !== 'string') return this._fail(field, `${name} is invalid.`);
    if (trim) v = v.trim();
    if (!v) {
      if (required) this._fail(field, `${name} is required.`);
      else this.out[field] = null;
      return this;
    }
    if (v.length < min) return this._fail(field, `${name} must be at least ${min} characters.`);
    if (v.length > max) return this._fail(field, `${name} must be ${max} characters or fewer.`);
    if (pattern && !pattern.test(v)) return this._fail(field, patternMessage || `${name} is not in the expected format.`);
    this.out[field] = v;
    return this;
  }

  email(field, { required = true } = {}) {
    this.string(field, { required, max: 254, label: 'Email address' });
    const v = this.out[field];
    if (v && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return this._fail(field, 'Enter a valid email address.');
    if (v) this.out[field] = v.toLowerCase();
    return this;
  }

  enum(field, allowed, { required = true, label } = {}) {
    const name = label || field;
    const v = this.body[field];
    if (v === undefined || v === null || v === '') {
      if (required) this._fail(field, `${name} is required.`);
      return this;
    }
    if (!allowed.includes(v)) return this._fail(field, `${name} is not a valid option.`);
    this.out[field] = v;
    return this;
  }

  int(field, { required = true, min, max, label } = {}) {
    const name = label || field;
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this._fail(field, `${name} is required.`);
      return this;
    }
    const n = Number(raw);
    if (!Number.isInteger(n)) return this._fail(field, `${name} must be a whole number.`);
    if (min !== undefined && n < min) return this._fail(field, `${name} must be at least ${min}.`);
    if (max !== undefined && n > max) return this._fail(field, `${name} must be at most ${max}.`);
    this.out[field] = n;
    return this;
  }

  bool(field, { mustBeTrue = false, label } = {}) {
    const v = this.body[field];
    const truthy = v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
    if (mustBeTrue && !truthy) return this._fail(field, `${label || field} must be accepted to continue.`);
    this.out[field] = truthy;
    return this;
  }

  isoDate(field, { required = true, label, notFuture = false } = {}) {
    const name = label || field;
    const v = this.body[field];
    if (!v) {
      if (required) this._fail(field, `${name} is required.`);
      return this;
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return this._fail(field, `${name} is not a valid date.`);
    if (notFuture && d.getTime() > Date.now() + 5 * 60 * 1000) {
      return this._fail(field, `${name} cannot be in the future.`);
    }
    this.out[field] = d.toISOString().replace('T', ' ').slice(0, 19);
    return this;
  }

  custom(field, message, ok) {
    if (!ok) this._fail(field, message);
    return this;
  }

  /** Throws a 422 carrying per-field messages, or returns the clean object. */
  done() {
    if (Object.keys(this.errors).length) throw invalid(this.errors);
    return this.out;
  }
}

const check = (body) => new Check(body);

/** Escape for safe interpolation into HTML. Used by the server-rendered parts. */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

module.exports = { check, Check, escapeHtml };
