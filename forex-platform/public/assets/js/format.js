/* Formatting helpers. Money always arrives from the server as integer cents. */

export function money(cents, { symbol = true, sign = false } = {}) {
  const n = Number(cents || 0);
  const negative = n < 0;
  const abs = Math.abs(n);
  const text = `${symbol ? '$' : ''}${(Math.floor(abs / 100)).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  if (negative) return `−${text}`;
  return sign && n > 0 ? `+${text}` : text;
}

/** Compact form for chart axes only; never for a figure the user must read exactly. */
export function moneyShort(cents) {
  const d = Math.abs(Number(cents || 0)) / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(d >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
}

/** The server stores UTC as "YYYY-MM-DD HH:MM:SS"; make it an actual Date. */
export function toDate(value) {
  if (!value) return null;
  const iso = typeof value === 'string' && value.includes(' ') ? `${value.replace(' ', 'T')}Z` : value;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dateTime(value) {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function dateOnly(value) {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function relative(value) {
  const d = toDate(value);
  if (!d) return '—';
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const units = [
    [60, 'minute', 60], [3600, 'hour', 3600], [86400, 'day', 86400], [604800, 'week', 604800],
  ];
  for (const [limit, name, divisor] of units) {
    if (seconds < limit * 60 || name === 'week') {
      const n = Math.round(seconds / divisor);
      if (n < 1) continue;
      if (name === 'week' && n > 4) break;
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return dateOnly(value);
}

export function titleCase(s) {
  return String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Status → badge class. The mapping is deliberately shared so a status never
 * appears green in one table and grey in another.
 */
const STATUS_TONE = {
  pending: 'warn', under_review: 'info', info_requested: 'warn',
  verified: 'pos', approved: 'pos', processing: 'info', completed: 'pos',
  rejected: 'neg', cancelled: 'neutral',
  normal: 'pos', active: 'pos', closed: 'neutral', closing: 'info',
  verification_required: 'warn', duplicate_suspected: 'warn',
  restricted: 'neg', suspended: 'neg', banned: 'neg',
  open: 'warn', pending_user: 'info', answered: 'pos', dismissed: 'neutral', confirmed: 'neg',
};

export function statusTone(status) {
  return STATUS_TONE[status] || 'neutral';
}

const STATUS_TEXT = {
  info_requested: 'Info requested',
  under_review: 'Under review',
  verification_required: 'Verification required',
  duplicate_suspected: 'Duplicate suspected',
  pending_user: 'Awaiting your reply',
};

export function statusLabel(status) {
  return STATUS_TEXT[status] || titleCase(status);
}
