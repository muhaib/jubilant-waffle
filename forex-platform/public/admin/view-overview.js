/* Console overview: live aggregates and the work queues, nothing simulated. */
import { api } from '/assets/js/api.js';
import { el, clear, emptyState } from '/assets/js/ui.js';
import { money } from '/assets/js/format.js';
import { areaChart, responsive, SERIES } from '/assets/js/charts.js';
import { go } from './admin.js';

function tile({ n, label, path, hot = false }) {
  return el('button', {
    class: `queue-tile${hot && n > 0 ? ' hot' : ''}`, type: 'button',
    onclick: () => path && go(path),
  }, [
    el('div', { class: 'n', text: String(n) }),
    el('div', { class: 'l', text: label }),
  ]);
}

function stat({ label, value, meta, accent = false }) {
  return el('div', { class: `stat${accent ? ' accent' : ''}` }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value sm', text: value }),
    meta ? el('div', { class: 'stat-meta', text: meta }) : null,
  ]);
}

export async function renderOverview() {
  const data = await api.get('/api/admin/overview');
  const u = data.users;
  const m = data.money;
  const root = el('div', { class: 'stack-6' });

  root.append(el('div', { class: 'page-head' }, [
    el('h2', { text: 'Overview' }),
    el('p', { text: 'Live totals across the platform. Every figure is an aggregate over real records — a new installation shows zeros, not sample data.' }),
  ]));

  root.append(el('div', {}, [
    el('div', { class: 'stat-label', style: 'margin-bottom:var(--s-3)', text: 'Work waiting on you' }),
    el('div', { class: 'queue-grid' }, [
      tile({ n: data.queues.deposits, label: 'Deposits to review', path: '/deposits', hot: true }),
      tile({ n: data.queues.withdrawals, label: 'Withdrawals to review', path: '/withdrawals', hot: true }),
      tile({ n: data.queues.kyc, label: 'Identity checks', path: '/users', hot: true }),
      tile({ n: data.queues.risk, label: 'Risk flags open', path: '/risk', hot: true }),
      tile({ n: data.queues.support, label: 'Support requests', path: '/support', hot: true }),
    ]),
  ]));

  root.append(el('div', { class: 'stat-grid' }, [
    stat({
      label: 'Outstanding liability', accent: true,
      value: money(data.outstandingLiabilityCents),
      meta: 'Total credited to user accounts across the ledger',
    }),
    stat({ label: 'Verified deposits', value: money(m.verified_deposit_cents), meta: `${m.verified_deposit_count} credited, lifetime` }),
    stat({ label: 'Completed withdrawals', value: money(m.completed_withdrawal_cents), meta: `${m.completed_withdrawal_count} paid out, lifetime` }),
    stat({ label: 'Realised profit credited', value: money(m.realised_profit_cents), meta: 'Posted by finance staff with an audit record' }),
  ]));

  root.append(el('div', { class: 'stat-grid' }, [
    stat({ label: 'Total users', value: String(u.total_users), meta: `${u.new_users_30d} joined in the last 30 days` }),
    stat({ label: 'Phone verified', value: String(u.verified_users), meta: `${u.pending_verification} awaiting verification` }),
    stat({ label: 'Active principal', value: money(m.active_principal_cents), meta: `${m.active_investment_count} open investments` }),
    stat({ label: 'Restricted accounts', value: String(u.suspended_users), meta: `${u.review_users} under review` }),
  ]));

  const depositChart = el('div');
  const signupChart = el('div');

  root.append(el('div', { class: 'split' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('h3', { text: 'Verified deposits' }),
          el('div', { class: 'sub', text: 'Last 30 days, by day' }),
        ]),
      ]),
      el('div', { class: 'card-body' }, [depositChart]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('h3', { text: 'Pending money' }),
          el('div', { class: 'sub', text: 'Not yet settled either way' }),
        ]),
      ]),
      el('div', { class: 'card-body' }, [
        el('dl', { class: 'deflist' }, [
          el('div', { class: 'defrow' }, [
            el('dt', { text: 'Deposits awaiting verification' }),
            el('dd', { text: `${money(m.pending_deposit_cents)} · ${m.pending_deposit_count}` }),
          ]),
          el('div', { class: 'defrow' }, [
            el('dt', { text: 'Withdrawals in the queue' }),
            el('dd', { text: `${money(m.pending_withdrawal_cents)} · ${m.pending_withdrawal_count}` }),
          ]),
          el('div', { class: 'defrow' }, [
            el('dt', { text: 'Deposits rejected, lifetime' }),
            el('dd', { text: String(m.rejected_deposit_count) }),
          ]),
          el('div', { class: 'defrow' }, [
            el('dt', { text: 'Identity checks waiting' }),
            el('dd', { text: String(u.pending_kyc) }),
          ]),
        ]),
        el('div', { class: 'notice notice-neutral', style: 'margin-top:var(--s-5)' }, [
          el('div', { text: 'Pending deposits are claims, not money. They are excluded from the outstanding liability above until verified.' }),
        ]),
      ]),
    ]),
  ]));

  queueMicrotask(() => {
    responsive(depositChart, () => areaChart(
      depositChart,
      data.charts.deposits.map((d) => ({ date: d.date, value: d.verifiedCents })),
      { series: SERIES.volume, emptyTitle: 'No verified deposits in the last 30 days',
        emptyBody: 'This chart is drawn from verified deposits only.' },
    ));
  });

  return root;
}
