/*
 * Dashboard.
 *
 * Deliberate separation on this screen: money that exists (available,
 * invested, realised profit) is presented as balance; money that has been
 * claimed but not verified (pending deposits) is kept visually apart; and the
 * illustrative figure is in its own card, labelled, never added to anything.
 */
import { api } from '/assets/js/api.js';
import { el, clear, emptyState } from '/assets/js/ui.js';
import { money, dateTime, relative, statusTone, statusLabel } from '/assets/js/format.js';
import { areaChart, groupedBars, responsive, SERIES } from '/assets/js/charts.js';
import { icon } from './icons.js';
import { store } from './app.js';

function stat({ label, value, meta, accent = false, tone }) {
  return el('div', { class: `stat${accent ? ' accent' : ''}` }, [
    el('div', { class: 'stat-label' }, [el('span', { text: label })]),
    el('div', { class: 'stat-value', style: tone ? `color:var(--${tone})` : null, text: value }),
    meta ? el('div', { class: 'stat-meta', text: meta }) : null,
  ]);
}

function statusBanner(user) {
  if (user.status === 'normal') return null;
  const copy = {
    verification_required: ['warn', 'Verify your mobile number to activate your account.'],
    duplicate_suspected: ['warn', 'Your account is being reviewed because our systems saw signals it shares with another account. Device signals are indicative and often match legitimately — a member of our team is looking at it. You keep full access to your records while we do.'],
    under_review: ['info', 'Your account is under review. You can still see all of your records.'],
    restricted: ['neg', 'Your account is restricted and cannot transact right now.'],
    suspended: ['neg', 'Your account is suspended. Contact support for assistance.'],
    banned: ['neg', 'Your account has been closed.'],
  }[user.status] || ['neutral', user.statusLabel];

  return el('div', { class: `notice notice-${copy[0]}`, style: 'margin-bottom:var(--s-5)' }, [
    el('div', {}, [
      el('strong', { text: user.statusLabel }),
      el('span', { text: user.statusReason ? `${copy[1]} Reason on file: ${user.statusReason}` : copy[1] }),
    ]),
  ]);
}

export async function renderDashboard() {
  const data = await api.get('/api/me/dashboard');
  store.balances = data.balances;
  store.user = data.user;

  const b = data.balances;
  const root = el('div', { class: 'stack-6' });

  const banner = statusBanner(data.user);
  if (banner) root.append(banner);

  root.append(el('div', { class: 'page-head' }, [
    el('h2', { text: `Good to see you, ${data.user.fullName.split(' ')[0]}` }),
    el('p', { text: `Account ${data.user.publicId}. Every figure below is derived from your ledger — nothing here is an estimate.` }),
  ]));

  /* -- Balance tiles ----------------------------------------------------- */
  root.append(el('div', { class: 'stat-grid' }, [
    stat({
      label: 'Total balance', accent: true,
      value: money(b.totalCents),
      meta: 'Available cash plus committed principal',
    }),
    stat({
      label: 'Available balance',
      value: money(b.availableCents),
      meta: 'What you can invest or withdraw now',
    }),
    stat({
      label: 'Invested amount',
      value: money(b.investedCents),
      meta: data.investments.length
        ? `${data.investments.length} open investment${data.investments.length === 1 ? '' : 's'}`
        : 'No open investments',
    }),
    stat({
      label: 'Realised profit',
      value: money(b.realizedProfitCents),
      tone: b.realizedProfitCents > 0 ? 'pos-700' : null,
      meta: b.realizedProfitCents > 0
        ? 'Profit actually credited to your account'
        : 'Nothing has been credited as profit yet',
    }),
  ]));

  /* -- Pending and lifetime totals --------------------------------------- */
  root.append(el('div', { class: 'stat-grid' }, [
    stat({
      label: 'Pending deposits',
      value: money(b.pendingDepositCents),
      meta: b.pendingDepositCount
        ? `${b.pendingDepositCount} awaiting verification — not yet part of your balance`
        : 'Nothing awaiting verification',
    }),
    stat({
      label: 'Pending withdrawals',
      value: money(b.pendingWithdrawalCents),
      meta: b.pendingWithdrawalCount
        ? `${b.pendingWithdrawalCount} in the queue — held from your available balance`
        : 'No requests in the queue',
    }),
    stat({ label: 'Total deposited', value: money(b.totalDepositedCents), meta: 'Verified deposits, lifetime' }),
    stat({ label: 'Total withdrawn', value: money(b.totalWithdrawnCents), meta: 'Completed payouts, lifetime' }),
  ]));

  /* -- Charts ------------------------------------------------------------ */
  const balanceHost = el('div');
  const monthlyHost = el('div');

  root.append(el('div', { class: 'split' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('h3', { text: 'Available balance' }),
          el('div', { class: 'sub', text: 'Reconstructed day by day from your ledger entries' }),
        ]),
      ]),
      el('div', { class: 'card-body' }, [balanceHost]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('h3', { text: 'Illustrative figure' }),
          el('div', { class: 'sub', text: 'An example, not a return' }),
        ]),
      ]),
      el('div', { class: 'card-body' }, [
        data.illustrative
          ? el('div', {}, [
            el('dl', { class: 'deflist' }, [
              el('div', { class: 'defrow' }, [
                el('dt', { text: 'Committed principal' }),
                el('dd', { text: money(data.illustrative.basisCents) }),
              ]),
              el('div', { class: 'defrow' }, [
                el('dt', { text: `Example daily (÷ ${data.illustrative.divisor})` }),
                el('dd', { text: money(data.illustrative.dailyCents) }),
              ]),
              el('div', { class: 'defrow' }, [
                el('dt', { text: `Example ${data.illustrative.cycleDays}-day` }),
                el('dd', { text: money(data.illustrative.cycleCents) }),
              ]),
            ]),
            el('div', { class: 'notice notice-warn', style: 'margin-top:var(--s-4)' }, [
              el('div', { text: data.illustrative.disclaimer }),
            ]),
          ])
          : emptyState({
            title: 'No open investment',
            body: 'Once you commit an amount, the example figures for it appear here — clearly separated from your actual balance.',
            action: el('a', { class: 'btn btn-secondary btn-sm', href: '#/investments', text: 'Open an investment' }),
          }),
      ]),
    ]),
  ]));

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [
      el('div', {}, [
        el('h3', { text: 'Money in and out' }),
        el('div', { class: 'sub', text: 'Settled movements by month' }),
      ]),
    ]),
    el('div', { class: 'card-body' }, [monthlyHost]),
  ]));

  /* -- Recent activity --------------------------------------------------- */
  const txnBody = el('tbody');
  if (!data.recentTransactions.length) {
    txnBody.append(el('tr', {}, [el('td', { colspan: '4' }, [emptyState({
      title: 'No transactions yet',
      body: 'Your first verified deposit will appear here as a ledger entry with its own reference.',
      action: el('a', { class: 'btn btn-primary btn-sm', href: '#/deposit', text: 'Make a deposit' }),
    })])]));
  } else {
    for (const t of data.recentTransactions) {
      txnBody.append(el('tr', {}, [
        el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: t.ref })]),
        el('td', { class: 'primary', dataset: { label: 'Type' }, text: statusLabel(t.type) }),
        el('td', { class: 'num', dataset: { label: 'Amount' },
          style: `color:var(--${t.direction === 'credit' ? 'pos-700' : 'ink-900'})`,
          text: `${t.direction === 'credit' ? '+' : '−'}${money(t.amountCents)}` }),
        el('td', { dataset: { label: 'When' }, class: 'muted', text: relative(t.createdAt) }),
      ]));
    }
  }

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [
      el('h3', { text: 'Recent ledger activity' }),
      el('a', { class: 'btn btn-secondary btn-sm', href: '#/transactions', text: 'View all' }),
    ]),
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Reference' }), el('th', { text: 'Type' }),
          el('th', { class: 'num', text: 'Amount' }), el('th', { text: 'When' }),
        ])]),
        txnBody,
      ]),
    ]),
  ]));

  // Charts render after the nodes are attached so they can measure width.
  queueMicrotask(() => {
    responsive(balanceHost, () => areaChart(
      balanceHost,
      data.charts.balance.map((d) => ({ date: d.date, value: d.balanceCents })),
      { series: SERIES.balance, emptyTitle: 'No balance history yet',
        emptyBody: 'This chart is drawn from your ledger. It fills in once your first deposit is verified.' },
    ));
    responsive(monthlyHost, () => groupedBars(
      monthlyHost,
      data.charts.monthly.map((m) => ({
        label: m.month.slice(5) + '/' + m.month.slice(2, 4),
        values: { withdrawn: m.withdrawnCents, deposited: m.depositedCents, profit: m.profitCents },
      })),
      ['withdrawn', 'deposited', 'profit'],
    ));
  });

  return root;
}
