'use strict';

/**
 * Fixed-window counters held in process memory.
 *
 * This is correct for a single instance, which is what the default deployment
 * is. Behind more than one Node process these counters are per-process and
 * the effective limit multiplies — move the store to Redis before scaling out.
 */
const buckets = new Map();

let lastSweep = Date.now();
function sweep(now) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, entry] of buckets) if (entry.resetAt <= now) buckets.delete(key);
}

/**
 * @returns {{ok: boolean, remaining: number, retryAfter: number}}
 */
function consume(key, limit, windowMs, cost = 1) {
  const now = Date.now();
  sweep(now);
  let entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    buckets.set(key, entry);
  }
  const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  if (entry.count + cost > limit) return { ok: false, remaining: 0, retryAfter };
  entry.count += cost;
  return { ok: true, remaining: limit - entry.count, retryAfter };
}

function peek(key) {
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= Date.now()) return { count: 0, resetAt: 0 };
  return { count: entry.count, resetAt: entry.resetAt };
}

function reset(key) { buckets.delete(key); }

module.exports = { consume, peek, reset };
