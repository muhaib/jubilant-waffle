'use strict';
const { db } = require('../db');

const selectAll = db.prepare('SELECT * FROM platform_settings');
const selectOne = db.prepare('SELECT * FROM platform_settings WHERE key = ?');

let cache = null;
function invalidate() { cache = null; }

function coerce(row) {
  switch (row.value_type) {
    case 'int':
    case 'money': return Number(row.value);
    case 'bool': return row.value === '1' || row.value === 'true';
    case 'json': try { return JSON.parse(row.value); } catch { return null; }
    default: return row.value;
  }
}

function all() {
  if (!cache) {
    cache = {};
    for (const row of selectAll.all()) cache[row.key] = coerce(row);
  }
  return cache;
}

function get(key, fallback) {
  const v = all()[key];
  return v === undefined ? fallback : v;
}

function rows() {
  return selectAll.all().map((r) => ({ ...r, parsed: coerce(r) }));
}

/**
 * Update a setting and record who changed it, from what, to what and why.
 * Callers are expected to also write an audit_logs row (see lib/audit).
 */
const updateStmt = db.prepare(
  `UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE key = ?`
);
const historyStmt = db.prepare(
  `INSERT INTO setting_history (key, old_value, new_value, admin_id, reason) VALUES (?,?,?,?,?)`
);

function set(key, rawValue, adminId, reason) {
  const existing = selectOne.get(key);
  if (!existing) throw new Error(`Unknown setting: ${key}`);
  const next = String(rawValue);
  if (existing.value !== next) {
    historyStmt.run(key, existing.value, next, adminId, reason || null);
    updateStmt.run(next, adminId, key);
    invalidate();
  }
  return { key, previous: existing.value, next };
}

/** The illustrative model parameters, read once per request path. */
function illustrativeModel() {
  return {
    divisor: get('illus_divisor', 30),
    cycleDays: get('illus_cycle_days', 24),
  };
}

function investmentLimits() {
  return {
    minCents: get('min_investment_cents', 3000),
    maxCents: get('max_investment_cents', 1000000),
  };
}

module.exports = { all, get, set, rows, invalidate, illustrativeModel, investmentLimits };
