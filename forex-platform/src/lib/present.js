'use strict';
const phone = require('./phone');

/**
 * Row → DTO mappers. Everything the API returns goes through here, so a
 * column added to a table is never accidentally exposed (password hashes,
 * OTP digests, ciphertext, internal ids).
 */

const STATUS_LABELS = {
  normal: 'Active',
  verification_required: 'Verification required',
  duplicate_suspected: 'Duplicate suspected',
  under_review: 'Under review',
  restricted: 'Restricted',
  suspended: 'Suspended',
  banned: 'Banned',
};

function user(u) {
  return {
    publicId: u.public_id,
    fullName: u.full_name,
    email: u.email,
    phoneMasked: phone.maskLocal(u.phone_e164),
    status: u.status,
    statusLabel: STATUS_LABELS[u.status] || u.status,
    statusReason: u.status_reason || null,
    phoneVerified: Boolean(u.phone_verified_at),
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

/** Admin view: the full phone number, because support needs to call it back. */
function userForAdmin(u) {
  return {
    ...user(u),
    id: u.id,
    phone: phone.formatLocal(u.phone_e164),
    phoneE164: u.phone_e164,
    signupIp: u.signup_ip,
    failedLogins: u.failed_logins,
    lockedUntil: u.locked_until,
    termsVersion: u.terms_version,
    termsAcceptedAt: u.terms_accepted_at,
    riskAckAt: u.risk_ack_at,
  };
}

function deposit(d, extra = {}) {
  return {
    ref: d.ref,
    amountCents: d.amount_cents,
    currency: d.currency,
    method: d.method_name || null,
    methodKey: d.method_key || null,
    senderAccount: d.sender_account,
    senderName: d.sender_name,
    providerTxnRef: d.provider_txn_ref,
    paidAt: d.paid_at,
    userNote: d.user_note,
    status: d.status,
    reviewNote: d.review_note,
    reviewedAt: d.reviewed_at,
    createdAt: d.created_at,
    hasEvidence: Boolean(d.evidence_count),
    ...extra,
  };
}

function withdrawal(w, extra = {}) {
  return {
    ref: w.ref,
    amountCents: w.amount_cents,
    feeCents: w.fee_cents,
    netCents: w.net_cents,
    currency: w.currency,
    method: w.method_name || null,
    payoutTitle: w.payout_title,
    payoutAccountMasked: maskAccount(w.payout_account),
    status: w.status,
    reviewNote: w.review_note,
    reviewedAt: w.reviewed_at,
    processedAt: w.processed_at,
    providerRef: w.provider_ref,
    createdAt: w.created_at,
    ...extra,
  };
}

function transaction(t) {
  return {
    ref: t.txn_ref,
    type: t.type,
    direction: t.direction,
    bucket: t.bucket,
    amountCents: t.amount_cents,
    currency: t.currency,
    source: t.source,
    status: t.status,
    memo: t.memo,
    createdAt: t.created_at,
  };
}

function investment(i) {
  return {
    ref: i.ref,
    principalCents: i.principal_cents,
    currency: i.currency,
    status: i.status,
    illustrative: {
      dailyCents: i.illus_daily_cents,
      cycleCents: i.illus_cycle_cents,
      divisor: i.model_divisor,
      cycleDays: i.model_cycle_days,
    },
    openedAt: i.opened_at,
    closedAt: i.closed_at,
    closeNote: i.close_note,
  };
}

function notification(n) {
  return {
    id: n.id,
    type: n.type,
    severity: n.severity,
    title: n.title,
    body: n.body,
    link: n.link,
    read: Boolean(n.read_at),
    createdAt: n.created_at,
  };
}

/** Never render more than the tail of a payout account number. */
function maskAccount(value) {
  const s = String(value || '');
  if (s.length <= 4) return '••••';
  return `${'•'.repeat(Math.max(3, s.length - 4))}${s.slice(-4)}`;
}

/**
 * Identity document masking, e.g. 42101-1234567-3 -> 42101-*******-3.
 * The full value is only ever released through a separately permissioned,
 * individually audited endpoint.
 */
function maskIdentityNumber(prefix, last) {
  return `${prefix}-${'*'.repeat(7)}-${last}`;
}

function statusEvent(e) {
  return {
    from: e.from_status,
    to: e.to_status,
    actor: e.actor_label,
    actorType: e.actor_type,
    note: e.note,
    at: e.created_at,
  };
}

module.exports = {
  user, userForAdmin, deposit, withdrawal, transaction, investment,
  notification, statusEvent, maskAccount, maskIdentityNumber, STATUS_LABELS,
};
