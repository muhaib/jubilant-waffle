'use strict';
const { db } = require('../db');
const audit = require('./audit');

/**
 * Duplicate-account and risk signalling.
 *
 * What this does NOT do: decide with certainty that two accounts are the same
 * person. Browser and device signals are indicative only — they collide
 * legitimately (shared family phone, office network, a public computer) and
 * they change (browser update, new handset, cleared storage). Accordingly a
 * match raises a flag for a human to review; it never auto-bans.
 */

const upsertDevice = db.prepare(`
  INSERT INTO devices (device_hash, user_id, user_agent, platform, screen, timezone, languages, first_seen_ip, last_seen_ip)
  VALUES (@device_hash, @user_id, @user_agent, @platform, @screen, @timezone, @languages, @ip, @ip)
  ON CONFLICT(device_hash, user_id) DO UPDATE SET
    seen_count   = seen_count + 1,
    last_seen_at = datetime('now'),
    last_seen_ip = excluded.last_seen_ip,
    user_agent   = excluded.user_agent
`);

const otherUsersOnDevice = db.prepare(`
  SELECT d.user_id, u.public_id, u.full_name, u.status
  FROM devices d JOIN users u ON u.id = d.user_id
  WHERE d.device_hash = ? AND d.user_id <> ?
`);

const openFlagExists = db.prepare(`
  SELECT id FROM risk_flags
  WHERE user_id = ? AND type = ? AND status IN ('open','under_review')
    AND COALESCE(related_user_id, -1) = COALESCE(?, -1)
`);

const insertFlag = db.prepare(`
  INSERT INTO risk_flags (user_id, type, severity, status, confidence, signals_json, related_user_id)
  VALUES (@user_id, @type, @severity, 'open', @confidence, @signals_json, @related_user_id)
`);

const setUserStatus = db.prepare(
  `UPDATE users SET status = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?`
);

function raiseFlag({ userId, type, severity = 'medium', confidence = 'indicative', signals = {}, relatedUserId = null }) {
  if (openFlagExists.get(userId, type, relatedUserId)) return null;
  const info = insertFlag.run({
    user_id: userId,
    type,
    severity,
    confidence,
    signals_json: JSON.stringify(signals),
    related_user_id: relatedUserId,
  });
  return Number(info.lastInsertRowid);
}

/**
 * Record the device a request came from and flag overlaps with other accounts.
 * Called on registration and on each successful login.
 */
function recordDevice(req, userId, fingerprint) {
  if (!fingerprint || !fingerprint.hash) return { flags: [] };
  upsertDevice.run({
    device_hash: String(fingerprint.hash).slice(0, 128),
    user_id: userId,
    user_agent: req.get('user-agent')?.slice(0, 400) || null,
    platform: fingerprint.platform ? String(fingerprint.platform).slice(0, 80) : null,
    screen: fingerprint.screen ? String(fingerprint.screen).slice(0, 40) : null,
    timezone: fingerprint.timezone ? String(fingerprint.timezone).slice(0, 60) : null,
    languages: fingerprint.languages ? String(fingerprint.languages).slice(0, 120) : null,
    ip: req.clientIp || null,
  });

  const others = otherUsersOnDevice.all(String(fingerprint.hash).slice(0, 128), userId);
  const flags = [];
  for (const other of others) {
    const id = raiseFlag({
      userId,
      type: 'duplicate_device',
      severity: 'medium',
      confidence: 'indicative',
      relatedUserId: other.user_id,
      signals: {
        matched_on: 'device_hash',
        other_account: other.public_id,
        note: 'Device signals are indicative and can collide legitimately. Confirm with an additional signal before acting.',
      },
    });
    if (id) {
      flags.push(id);
      audit.record(req, {
        action: 'risk.flag_raised',
        entityType: 'risk_flag',
        entityId: id,
        next: { type: 'duplicate_device', related: other.public_id },
        actor: { type: 'system', id: null, label: 'risk-engine' },
      });
    }
  }
  return { flags, matches: others };
}

const kycDigestMatches = db.prepare(`
  SELECT k.user_id, u.public_id FROM kyc_records k JOIN users u ON u.id = k.user_id
  WHERE k.id_digest = ? AND k.user_id <> ?
`);

/** A repeated identity document is a much stronger signal than a device match. */
function checkKycDuplicate(req, userId, idDigest) {
  const matches = kycDigestMatches.all(idDigest, userId);
  const flags = [];
  for (const m of matches) {
    const id = raiseFlag({
      userId,
      type: 'duplicate_kyc',
      severity: 'high',
      confidence: 'strong',
      relatedUserId: m.user_id,
      signals: { matched_on: 'identity_document_digest', other_account: m.public_id },
    });
    if (id) {
      flags.push(id);
      moveToReview(req, userId, `Identity document already submitted on account ${m.public_id}.`);
    }
  }
  return { flags, matches };
}

const payoutMatches = db.prepare(`
  SELECT w.user_id, u.public_id FROM withdrawals w JOIN users u ON u.id = w.user_id
  WHERE w.payout_account = ? AND w.user_id <> ? GROUP BY w.user_id
`);

function checkPayoutReuse(req, userId, payoutAccount) {
  const matches = payoutMatches.all(payoutAccount, userId);
  for (const m of matches) {
    raiseFlag({
      userId,
      type: 'duplicate_payout',
      severity: 'high',
      confidence: 'strong',
      relatedUserId: m.user_id,
      signals: { matched_on: 'payout_account', other_account: m.public_id },
    });
  }
  return matches;
}

/**
 * Put an account into review rather than restricting it. A legitimate user
 * keeps read access to their account and their money while a person looks.
 */
function moveToReview(req, userId, reason) {
  const user = db.prepare('SELECT id, status, public_id FROM users WHERE id = ?').get(userId);
  if (!user) return;
  if (['suspended', 'banned', 'restricted'].includes(user.status)) return;
  if (user.status === 'duplicate_suspected') return;
  setUserStatus.run('duplicate_suspected', reason, userId);
  audit.record(req, {
    action: 'user.status_changed',
    entityType: 'user',
    entityId: userId,
    entityLabel: user.public_id,
    previous: user.status,
    next: 'duplicate_suspected',
    reason,
    actor: { type: 'system', id: null, label: 'risk-engine' },
  });
  audit.status(req, {
    entityType: 'user', entityId: userId, from: user.status, to: 'duplicate_suspected',
    note: reason, actor: { type: 'system', id: null, label: 'risk-engine' },
  });
}

module.exports = { recordDevice, checkKycDuplicate, checkPayoutReuse, raiseFlag, moveToReview };
