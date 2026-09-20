/*
 * Review queues: deposits, withdrawals, the cross-account ledger, risk flags
 * and support.
 *
 * The deposit review screen is written to resist the single most dangerous
 * habit in this kind of platform — treating a screenshot as proof. The image
 * is presented as supporting material, the reconciliation checklist is
 * explicit, and crediting requires ticking a confirmation that says what the
 * reviewer is attesting to.
 */
import { api, ApiError } from '/assets/js/api.js';
import {
  el, clear, $, toast, emptyState, busy, confirmDialog, applyFieldErrors, clearFieldErrors,
} from '/assets/js/ui.js';
import { money, dateTime, dateOnly, relative, statusTone, statusLabel } from '/assets/js/format.js';
import { icon } from '/app/icons.js';
import { admin, can, go } from './admin.js';

const badge = (status) => el('span', { class: `badge badge-${statusTone(status)}`, text: statusLabel(status) });

function head(title, description, action) {
  return el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [el('h2', { text: title }), el('p', { text: description })]),
      action || null,
    ]),
  ]);
}

function filterBar({ statuses, current, onStatus, onSearch, placeholder }) {
  return el('div', { class: 'filters' }, [
    el('label', { class: 'visually-hidden', for: 'q', text: 'Search' }),
    el('input', {
      class: 'input search', type: 'search', id: 'q', placeholder,
      onkeydown: (e) => { if (e.key === 'Enter') onSearch(e.target.value); },
    }),
    el('label', { class: 'visually-hidden', for: 'status', text: 'Filter by status' }),
    el('select', {
      class: 'select', id: 'status', style: 'max-width:200px',
      onchange: (e) => onStatus(e.target.value),
    }, [
      el('option', { value: '', text: 'All statuses' }),
      ...statuses.map((s) => el('option', { value: s, text: statusLabel(s), selected: s === current })),
    ]),
  ]);
}

function timeline(events) {
  if (!events.length) return el('p', { class: 'muted', text: 'No status changes recorded.' });
  return el('ol', { class: 'timeline' }, events.map((e) => el('li', {}, [
    el('div', { class: 't-title', text: statusLabel(e.to) }),
    el('div', { class: 't-meta', text: `${dateTime(e.at)} · ${e.actor}` }),
    e.note ? el('div', { class: 't-note', text: e.note }) : null,
  ])));
}

/* ===========================================================================
   Deposits
   =========================================================================== */
export async function renderDeposits() {
  const root = el('div', { class: 'stack-6' });
  root.append(head('Deposits', 'Claims submitted by users. Nothing here has credited a balance unless it shows as verified.'));

  const listCard = el('div', { class: 'card' });
  let status = 'pending';
  let query = '';

  async function load() {
    clear(listCard).append(el('div', { class: 'card-body' }, [
      el('div', { class: 'skeleton skeleton-line', style: 'width:100%' }),
      el('div', { class: 'skeleton skeleton-line', style: 'width:80%' }),
    ]));
    const params = new URLSearchParams({ limit: '50' });
    if (status) params.set('status', status);
    if (query) params.set('q', query);
    const data = await api.get(`/api/admin/deposits?${params}`);

    if (!bar.childElementCount) {
      bar.append(...filterBar({
        statuses: data.statuses, current: status, placeholder: 'Reference, transaction ID, user…',
        onStatus: (v) => { status = v; load(); },
        onSearch: (v) => { query = v; load(); },
      }).childNodes);
    }

    if (!data.items.length) {
      clear(listCard).append(el('div', { class: 'card-body' }, [emptyState({
        title: status ? `No ${statusLabel(status).toLowerCase()} deposits` : 'No deposits',
        body: 'Nothing matches the current filter.',
      })]));
      return;
    }

    const body = el('tbody');
    for (const d of data.items) {
      body.append(el('tr', { class: 'clickable', onclick: () => go(`/deposits/${d.ref}`) }, [
        el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: d.ref })]),
        el('td', { dataset: { label: 'User' } }, [
          el('div', { class: 'primary', text: d.user.fullName }),
          el('div', { class: 'ref muted', text: d.user.publicId }),
        ]),
        el('td', { class: 'num primary', dataset: { label: 'Amount' }, text: money(d.amountCents) }),
        el('td', { dataset: { label: 'Transaction ID' }, class: 'mono muted', text: d.providerTxnRef }),
        el('td', { dataset: { label: 'Submitted' }, class: 'muted', text: relative(d.createdAt) }),
        el('td', { dataset: { label: 'Status' } }, [badge(d.status)]),
      ]));
    }

    clear(listCard).append(
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data stackable' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Reference' }), el('th', { text: 'User' }), el('th', { class: 'num', text: 'Amount' }),
            el('th', { text: 'Transaction ID' }), el('th', { text: 'Submitted' }), el('th', { text: 'Status' }),
          ])]),
          body,
        ]),
      ]),
      el('div', { class: 'card-footer', text: `${data.items.length} of ${data.total} shown.` }),
    );
  }

  const bar = el('div', { class: 'filters' });
  root.append(bar, listCard);
  await load();
  return root;
}

export async function renderDepositReview([ref]) {
  const data = await api.get(`/api/admin/deposits/${encodeURIComponent(ref)}`);
  const d = data.deposit;
  const root = el('div', { class: 'stack-6' });

  root.append(el('a', { class: 'back-link', href: '#/deposits' }, [icon('list', 14), el('span', { text: 'All deposits' })]));
  root.append(el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [
        el('h2', { text: `${money(d.amountCents)} claimed` }),
        el('p', {}, [el('span', { class: 'ref', text: d.ref }), ` · submitted ${dateTime(d.createdAt)}`]),
      ]),
      badge(d.status),
    ]),
  ]));

  if (data.duplicateReferences.length) {
    root.append(el('div', { class: 'notice notice-neg' }, [
      el('div', {}, [
        el('strong', { text: 'This transaction ID has been submitted before' }),
        el('span', { text: data.duplicateReferences.map((r) => `${r.ref} (${statusLabel(r.status)})`).join(', ') }),
      ]),
    ]));
  }
  if (data.user.openFlags > 0) {
    root.append(el('div', { class: 'notice notice-warn' }, [
      el('div', {}, [
        el('strong', { text: `${data.user.openFlags} open risk flag${data.user.openFlags === 1 ? '' : 's'} on this account` }),
        el('span', { text: 'Review the flags before crediting anything.' }),
      ]),
    ]));
  }

  const decided = ['verified', 'rejected', 'cancelled'].includes(d.status);

  /* -- Decision panel ---------------------------------------------------- */
  const checklist = el('ul', { class: 'checklist' }, data.verificationChecklist.map((text, i) => el('li', {}, [
    el('input', { type: 'checkbox', id: `chk-${i}` }),
    el('label', { for: `chk-${i}`, text, style: 'cursor:pointer' }),
  ])));

  const noteInput = el('textarea', {
    class: 'textarea', id: 'note', name: 'note', rows: '3',
    placeholder: 'Reason or note — shown to the user for a rejection or an information request.',
  });

  async function decide(decision, label, tone) {
    const note = noteInput.value.trim();
    if (decision === 'reject' && note.length < 4) {
      toast('Enter a reason — the user sees it.', 'warn');
      noteInput.focus();
      return;
    }
    const ok = await confirmDialog({
      title: `${label} deposit ${d.ref}?`,
      body: el('div', {}, [
        el('p', { class: 'muted', text: decision === 'verify'
          ? `This posts a permanent ledger credit of ${money(d.amountCents)} to ${data.user.publicId}. It cannot be edited afterwards — only corrected by a separate, audited adjustment.`
          : `This records the decision against ${d.ref} and notifies ${data.user.publicId}. No money moves.` }),
        note ? el('div', { class: 'notice notice-neutral', style: 'margin-top:var(--s-4)' }, [
          el('div', {}, [el('strong', { text: 'Note to the user' }), el('span', { text: note })]),
        ]) : null,
      ]),
      confirmLabel: label,
      tone,
      checkboxLabel: decision === 'verify'
        ? 'I confirm I have matched this payment against our receiving account records — not only the screenshot.'
        : null,
    });
    if (!ok) return;

    try {
      const result = await api.post(`/api/admin/deposits/${encodeURIComponent(ref)}/decision`, {
        decision, note: note || null,
        confirm_reconciled: decision === 'verify' ? true : undefined,
      });
      toast(result.transaction
        ? `Credited. Ledger reference ${result.transaction}.`
        : `Deposit marked ${statusLabel(result.status).toLowerCase()}.`, 'pos');
      go('/deposits');
    } catch (error) {
      toast(error.message, 'neg');
    }
  }

  const actions = decided
    ? el('div', { class: 'notice notice-neutral' }, [
      el('div', {}, [
        el('strong', { text: `Already ${statusLabel(d.status).toLowerCase()}` }),
        el('span', { text: 'A settled deposit cannot be decided again. If this was wrong, post an audited balance adjustment on the user’s account instead.' }),
      ]),
    ])
    : el('div', { class: 'stack-4' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'note', text: 'Note' }),
        noteInput,
      ]),
      can('deposits.review')
        ? el('div', { class: 'row', style: 'gap:var(--s-2)' }, [
          el('button', { class: 'btn btn-success', type: 'button', text: 'Verify & credit',
            onclick: () => decide('verify', 'Verify and credit', 'success') }),
          el('button', { class: 'btn btn-danger', type: 'button', text: 'Reject',
            onclick: () => decide('reject', 'Reject', 'danger') }),
          el('button', { class: 'btn btn-secondary', type: 'button', text: 'Request info',
            onclick: () => decide('request_info', 'Request more information', 'primary') }),
          el('button', { class: 'btn btn-secondary', type: 'button', text: 'Mark under review',
            onclick: () => decide('under_review', 'Mark under review', 'primary') }),
        ])
        : el('p', { class: 'muted', text: 'Your role can view deposits but not decide them.' }),
    ]);

  const evidence = data.evidence.length
    ? el('div', {}, data.evidence.map((f) => el('div', { class: 'evidence-frame', style: 'margin-bottom:var(--s-3)' }, [
      el('img', { src: f.url, alt: `Payment evidence for ${d.ref}`, loading: 'lazy' }),
      el('div', { class: 'evidence-caption' }, [
        el('div', { text: `${f.name} · ${(f.sizeBytes / 1024).toFixed(0)} KB · uploaded ${dateTime(f.uploadedAt)}` }),
        el('div', { class: 'mono', style: 'margin-top:4px;word-break:break-all', text: `sha256 ${f.sha256.slice(0, 32)}…` }),
        f.identicalUploads > 1
          ? el('div', { style: 'color:var(--neg-700);font-weight:560;margin-top:4px',
            text: `These exact bytes have been uploaded ${f.identicalUploads} times across the platform.` })
          : null,
        f.scanStatus === 'not_scanned'
          ? el('div', { class: 'muted', style: 'margin-top:4px', text: 'No malware scanner is configured on this deployment.' })
          : null,
      ]),
    ])))
    : el('p', { class: 'muted', text: 'No evidence was attached.' });

  root.append(el('div', { class: 'review-layout' }, [
    el('div', { class: 'stack-4' }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'What the user claims' })]),
        el('div', { class: 'card-body' }, [
          el('dl', { class: 'deflist' }, [
            el('div', { class: 'defrow' }, [el('dt', { text: 'Amount' }), el('dd', { text: money(d.amountCents) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Method' }), el('dd', { text: d.method })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Transaction ID' }), el('dd', { class: 'mono', text: d.providerTxnRef })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Sent from' }), el('dd', { text: d.senderAccount })]),
            d.senderName ? el('div', { class: 'defrow' }, [el('dt', { text: 'Sender name' }), el('dd', { text: d.senderName })]) : null,
            el('div', { class: 'defrow' }, [el('dt', { text: 'Claimed paid at' }), el('dd', { text: dateTime(d.paidAt) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Should have landed in' }), el('dd', { class: 'mono', text: data.receivingAccount || 'not configured' })]),
            d.userNote ? el('div', { class: 'defrow' }, [el('dt', { text: 'User note' }), el('dd', { text: d.userNote })]) : null,
          ]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', {}, [
            el('h3', { text: 'Supporting evidence' }),
            el('div', { class: 'sub', text: 'Not proof of receipt on its own' }),
          ]),
        ]),
        el('div', { class: 'card-body' }, [evidence]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'Decision' })]),
        el('div', { class: 'card-body' }, [
          el('p', { class: 'muted', style: 'font-size:var(--t-base);margin-bottom:var(--s-4)',
            text: 'Work through the reconciliation checklist before you credit anything.' }),
          checklist,
          el('hr', { class: 'divider' }),
          actions,
        ]),
      ]),
    ]),

    el('div', { class: 'stack-4' }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'The account' })]),
        el('div', { class: 'card-body' }, [
          el('dl', { class: 'deflist' }, [
            el('div', { class: 'defrow' }, [el('dt', { text: 'Name' }), el('dd', { text: data.user.fullName })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Account ID' }), el('dd', { class: 'mono', text: data.user.publicId })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Phone' }), el('dd', { text: data.user.phone })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Status' }), el('dd', {}, [badge(data.user.status)])]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Member since' }), el('dd', { text: dateOnly(data.user.memberSince) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Available balance' }), el('dd', { text: money(data.user.balances.availableCents) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Total deposited' }), el('dd', { text: money(data.user.balances.totalDepositedCents) })]),
          ]),
          el('a', { class: 'btn btn-secondary btn-sm btn-block', style: 'margin-top:var(--s-4)',
            href: `#/users/${data.user.publicId}`, text: 'Open full account' }),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'Deposit history' })]),
        el('div', { class: 'card-body' }, [
          data.user.history.length
            ? el('dl', { class: 'deflist' }, data.user.history.map((h) => el('div', { class: 'defrow' }, [
              el('dt', { text: statusLabel(h.status) }),
              el('dd', { text: `${h.n} · ${money(h.cents)}` }),
            ])))
            : el('p', { class: 'muted', text: 'This is their first deposit.' }),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'History' })]),
        el('div', { class: 'card-body' }, [timeline(data.history)]),
      ]),
    ]),
  ]));

  return root;
}

/* ===========================================================================
   Withdrawals
   =========================================================================== */
export async function renderWithdrawals() {
  const root = el('div', { class: 'stack-6' });
  root.append(head('Withdrawals', 'Requests from users. The amount is already held from their available balance.'));

  const bar = el('div', { class: 'filters' });
  const listCard = el('div', { class: 'card' });
  let status = 'pending';
  let query = '';

  async function load() {
    clear(listCard).append(el('div', { class: 'card-body' }, [
      el('div', { class: 'skeleton skeleton-line', style: 'width:100%' }),
      el('div', { class: 'skeleton skeleton-line', style: 'width:80%' }),
    ]));
    const params = new URLSearchParams({ limit: '50' });
    if (status) params.set('status', status);
    if (query) params.set('q', query);
    const data = await api.get(`/api/admin/withdrawals?${params}`);

    if (!bar.childElementCount) {
      bar.append(...filterBar({
        statuses: data.statuses, current: status, placeholder: 'Reference, user…',
        onStatus: (v) => { status = v; load(); },
        onSearch: (v) => { query = v; load(); },
      }).childNodes);
    }

    if (!data.items.length) {
      clear(listCard).append(el('div', { class: 'card-body' }, [emptyState({
        title: 'Nothing in this queue', body: 'No withdrawal requests match the current filter.',
      })]));
      return;
    }

    const body = el('tbody');
    for (const w of data.items) {
      body.append(el('tr', { class: 'clickable', onclick: () => go(`/withdrawals/${w.ref}`) }, [
        el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: w.ref })]),
        el('td', { dataset: { label: 'User' } }, [
          el('div', { class: 'primary', text: w.user.fullName }),
          el('div', { class: 'ref muted', text: w.user.publicId }),
        ]),
        el('td', { class: 'num primary', dataset: { label: 'Amount' }, text: money(w.amountCents) }),
        el('td', { class: 'num', dataset: { label: 'Net' }, text: money(w.netCents) }),
        el('td', { dataset: { label: 'Requested' }, class: 'muted', text: relative(w.createdAt) }),
        el('td', { dataset: { label: 'Status' } }, [badge(w.status)]),
      ]));
    }

    clear(listCard).append(
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data stackable' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Reference' }), el('th', { text: 'User' }), el('th', { class: 'num', text: 'Amount' }),
            el('th', { class: 'num', text: 'Net' }), el('th', { text: 'Requested' }), el('th', { text: 'Status' }),
          ])]),
          body,
        ]),
      ]),
      el('div', { class: 'card-footer', text: `${data.items.length} of ${data.total} shown.` }),
    );
  }

  root.append(bar, listCard);
  await load();
  return root;
}

const NEXT_STATES = {
  pending: [['under_review', 'Mark under review', 'secondary'], ['approved', 'Approve', 'success'], ['rejected', 'Reject', 'danger']],
  under_review: [['approved', 'Approve', 'success'], ['rejected', 'Reject', 'danger']],
  approved: [['processing', 'Start processing', 'primary'], ['rejected', 'Reject', 'danger']],
  processing: [['completed', 'Mark paid out', 'success'], ['rejected', 'Reject', 'danger']],
};

export async function renderWithdrawalReview([ref]) {
  const data = await api.get(`/api/admin/withdrawals/${encodeURIComponent(ref)}`);
  const w = data.withdrawal;
  const root = el('div', { class: 'stack-6' });

  root.append(el('a', { class: 'back-link', href: '#/withdrawals' }, [icon('list', 14), el('span', { text: 'All withdrawals' })]));
  root.append(el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [
        el('h2', { text: money(w.amountCents) }),
        el('p', {}, [el('span', { class: 'ref', text: w.ref }), ` · requested ${dateTime(w.createdAt)}`]),
      ]),
      badge(w.status),
    ]),
  ]));

  if (data.payoutSharedWith.length) {
    root.append(el('div', { class: 'notice notice-neg' }, [
      el('div', {}, [
        el('strong', { text: 'This payout account is used by other accounts' }),
        el('span', { text: `${data.payoutSharedWith.map((u) => `${u.fullName} (${u.publicId})`).join(', ')}. A shared payout account is a strong duplicate signal — check before paying.` }),
      ]),
    ]));
  }

  const providerInput = el('input', { class: 'input', id: 'provider_ref', name: 'provider_ref', type: 'text',
    placeholder: 'Provider transaction reference' });
  const noteInput = el('textarea', { class: 'textarea', id: 'note', rows: '3',
    placeholder: 'Note — shown to the user on a rejection.' });

  async function move(next, label, tone) {
    const note = noteInput.value.trim();
    if (next === 'rejected' && note.length < 4) { toast('Enter a reason — the user sees it.', 'warn'); noteInput.focus(); return; }
    if (next === 'completed' && !providerInput.value.trim()) {
      toast('Record the provider reference for this payout.', 'warn'); providerInput.focus(); return;
    }
    const ok = await confirmDialog({
      title: `${label}?`,
      body: next === 'completed'
        ? `This posts a settlement debit of ${money(w.amountCents)} and tells ${data.user.publicId} the money has been sent. Only do this once the payment has actually left.`
        : next === 'rejected'
          ? `${money(w.amountCents)} is returned to ${data.user.publicId}'s available balance.`
          : `The request moves to ${statusLabel(next).toLowerCase()}. No money moves.`,
      confirmLabel: label, tone,
    });
    if (!ok) return;
    try {
      await api.post(`/api/admin/withdrawals/${encodeURIComponent(ref)}/decision`, {
        status: next, note: note || null, provider_ref: providerInput.value.trim() || null,
      });
      toast(`Withdrawal ${statusLabel(next).toLowerCase()}.`, 'pos');
      go('/withdrawals');
    } catch (error) { toast(error.message, 'neg'); }
  }

  const transitions = NEXT_STATES[w.status] || [];
  const actionPanel = transitions.length
    ? el('div', { class: 'stack-4' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'note', text: 'Note' }), noteInput,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'provider_ref' }, [
          'Provider reference ', el('span', { class: 'optional', text: '(required to mark paid out)' }),
        ]),
        providerInput,
      ]),
      el('div', { class: 'row', style: 'gap:var(--s-2)' }, transitions.map(([next, label, tone]) => {
        const needsProcess = ['processing', 'completed'].includes(next);
        const permitted = can(needsProcess ? 'withdrawals.process' : 'withdrawals.review');
        return el('button', {
          class: `btn btn-${tone}`, type: 'button', text: label,
          disabled: !permitted,
          title: permitted ? null : `Requires the withdrawals.${needsProcess ? 'process' : 'review'} permission`,
          onclick: () => move(next, label, tone === 'danger' ? 'danger' : tone === 'success' ? 'success' : 'primary'),
        });
      })),
    ])
    : el('div', { class: 'notice notice-neutral' }, [
      el('div', {}, [
        el('strong', { text: `This request is ${statusLabel(w.status).toLowerCase()}` }),
        el('span', { text: 'It is final. A correction must be made as an audited balance adjustment on the user’s account.' }),
      ]),
    ]);

  root.append(el('div', { class: 'review-layout' }, [
    el('div', { class: 'stack-4' }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'Payout instruction' })]),
        el('div', { class: 'card-body' }, [
          el('dl', { class: 'deflist' }, [
            el('div', { class: 'defrow' }, [el('dt', { text: 'Amount requested' }), el('dd', { text: money(w.amountCents) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Fee' }), el('dd', { text: w.feeCents ? money(w.feeCents) : 'None' })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Pay out' }), el('dd', { text: money(w.netCents) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Method' }), el('dd', { text: w.method })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Account title' }), el('dd', { text: w.payoutTitle })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Account number' }), el('dd', { class: 'mono', text: w.payoutAccount })]),
          ]),
          w.payoutTitle.trim().toLowerCase() !== data.user.fullName.trim().toLowerCase()
            ? el('div', { class: 'notice notice-warn', style: 'margin-top:var(--s-4)' }, [
              el('div', { text: `The payout account title does not match the account holder's name (${data.user.fullName}). Confirm before paying.` }),
            ])
            : null,
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'Decision' })]),
        el('div', { class: 'card-body' }, [actionPanel]),
      ]),
    ]),
    el('div', { class: 'stack-4' }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'The account' })]),
        el('div', { class: 'card-body' }, [
          el('dl', { class: 'deflist' }, [
            el('div', { class: 'defrow' }, [el('dt', { text: 'Name' }), el('dd', { text: data.user.fullName })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Account ID' }), el('dd', { class: 'mono', text: data.user.publicId })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Phone' }), el('dd', { text: data.user.phone })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Status' }), el('dd', {}, [badge(data.user.status)])]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Available now' }), el('dd', { text: money(data.user.balances.availableCents) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Total deposited' }), el('dd', { text: money(data.user.totalDepositedCents) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Prior payouts' }), el('dd', { text: String(data.user.priorWithdrawals) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Open risk flags' }), el('dd', { text: String(data.user.openFlags) })]),
          ]),
          el('a', { class: 'btn btn-secondary btn-sm btn-block', style: 'margin-top:var(--s-4)',
            href: `#/users/${data.user.publicId}`, text: 'Open full account' }),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'History' })]),
        el('div', { class: 'card-body' }, [timeline(data.history)]),
      ]),
    ]),
  ]));

  return root;
}

/* ===========================================================================
   Ledger
   =========================================================================== */
export async function renderLedger() {
  const data = await api.get('/api/admin/ledger?limit=100');
  const root = el('div', { class: 'stack-6' });
  root.append(head('Ledger', 'Every financial movement across all accounts, newest first. Entries are immutable.'));

  if (!data.items.length) {
    root.append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({
      title: 'The ledger is empty', body: 'Entries appear as deposits are verified and money moves.',
    })])]));
    return root;
  }

  const body = el('tbody');
  for (const t of data.items) {
    body.append(el('tr', {}, [
      el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: t.ref })]),
      el('td', { dataset: { label: 'User' } }, [
        el('div', { class: 'primary', text: t.user.fullName }),
        el('div', { class: 'ref muted', text: t.user.publicId }),
      ]),
      el('td', { dataset: { label: 'Type' }, text: statusLabel(t.type) }),
      el('td', { dataset: { label: 'Bucket' }, class: 'muted', text: t.bucket === 'invested' ? 'Invested' : 'Available' }),
      el('td', {
        class: 'num', dataset: { label: 'Amount' },
        style: `color:var(--${t.direction === 'credit' ? 'pos-700' : 'ink-900'});font-weight:560`,
        text: `${t.direction === 'credit' ? '+' : '−'}${money(t.amountCents)}`,
      }),
      el('td', { dataset: { label: 'Posted' }, class: 'muted', text: dateTime(t.createdAt) }),
      el('td', { dataset: { label: 'Status' } }, [
        t.status === 'reversed'
          ? el('span', { class: 'badge badge-neutral', text: 'Reversed' })
          : el('span', { class: 'badge badge-pos', text: 'Posted' }),
      ]),
    ]));
  }

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Reference' }), el('th', { text: 'User' }), el('th', { text: 'Type' }),
          el('th', { text: 'Bucket' }), el('th', { class: 'num', text: 'Amount' }),
          el('th', { text: 'Posted' }), el('th', { text: 'Status' }),
        ])]),
        body,
      ]),
    ]),
    el('div', { class: 'card-footer', text: `Showing ${data.items.length} of ${data.total} entries. A reversed row is cancelled by its mirroring entry; neither is ever deleted.` }),
  ]));
  return root;
}

/* ===========================================================================
   Risk flags
   =========================================================================== */
export async function renderRisk() {
  const data = await api.get('/api/admin/risk-flags');
  const root = el('div', { class: 'stack-6' });
  root.append(head('Risk flags', 'Duplicate-account and payment signals raised for a human to judge.'));

  root.append(el('div', { class: 'notice notice-warn' }, [
    el('div', {}, [el('strong', { text: 'Signals are indicative, not conclusive' }), el('span', { text: data.guidance })]),
  ]));

  if (!data.items.length) {
    root.append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({
      title: 'No open flags', body: 'Nothing is currently waiting for a duplicate-account decision.',
    })])]));
    return root;
  }

  const cards = data.items.map((f) => el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [
      el('div', {}, [
        el('h3', { text: statusLabel(f.type) }),
        el('div', { class: 'sub', text: `Raised ${relative(f.createdAt)} · confidence: ${f.confidence}` }),
      ]),
      el('span', { class: `badge badge-${f.severity === 'high' ? 'neg' : f.severity === 'low' ? 'neutral' : 'warn'}`,
        text: `${f.severity} severity` }),
    ]),
    el('div', { class: 'card-body' }, [
      el('dl', { class: 'deflist' }, [
        el('div', { class: 'defrow' }, [
          el('dt', { text: 'Account' }),
          el('dd', {}, [el('a', { href: `#/users/${f.user.publicId}`, text: `${f.user.fullName} (${f.user.publicId})` })]),
        ]),
        f.relatedUser ? el('div', { class: 'defrow' }, [
          el('dt', { text: 'Matched with' }),
          el('dd', {}, [el('a', { href: `#/users/${f.relatedUser.publicId}`, text: `${f.relatedUser.fullName} (${f.relatedUser.publicId})` })]),
        ]) : null,
        el('div', { class: 'defrow' }, [el('dt', { text: 'Matched on' }), el('dd', { text: f.signals.matched_on || '—' })]),
        el('div', { class: 'defrow' }, [el('dt', { text: 'Account status' }), el('dd', {}, [badge(f.user.status)])]),
      ]),
      f.signals.note ? el('p', { class: 'hint', style: 'margin-top:var(--s-3)', text: f.signals.note }) : null,
      can('risk.review')
        ? el('div', { class: 'row', style: 'gap:var(--s-2);margin-top:var(--s-5)' }, [
          el('button', {
            class: 'btn btn-secondary', type: 'button', text: 'Dismiss — not a duplicate',
            onclick: () => resolve(f.id, 'dismissed', 'Dismiss this flag?', 'primary'),
          }),
          el('button', {
            class: 'btn btn-danger', type: 'button', text: 'Confirm duplicate',
            onclick: () => resolve(f.id, 'confirmed', 'Confirm this is a duplicate account?', 'danger'),
          }),
        ])
        : el('p', { class: 'muted', style: 'margin-top:var(--s-4)', text: 'Your role can view flags but not resolve them.' }),
    ]),
  ]));

  async function resolve(id, resolution, title, tone) {
    const note = await confirmDialog({
      title,
      body: resolution === 'dismissed'
        ? 'Dismissing clears the flag. If it was the only open flag, the account returns to normal automatically.'
        : 'Confirming records your finding. It does not by itself restrict the account — do that separately from the user’s page, so the restriction carries its own reason.',
      confirmLabel: resolution === 'dismissed' ? 'Dismiss' : 'Confirm duplicate',
      tone, requireNote: true, noteLabel: 'What did you check?',
      notePlaceholder: 'e.g. Different CNIC, different payout account, spoke to both users by phone.',
    });
    if (!note) return;
    try {
      await api.post(`/api/admin/risk-flags/${id}/resolve`, { resolution, note });
      toast('Flag resolved.', 'pos');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) { toast(error.message, 'neg'); }
  }

  root.append(el('div', { class: 'stack-4' }, cards));
  return root;
}

/* ===========================================================================
   Support
   =========================================================================== */
export async function renderSupport() {
  const data = await api.get('/api/admin/support');
  const root = el('div', { class: 'stack-6' });
  root.append(head('Support', 'Requests raised by users from inside their account.'));

  if (!data.items.length) {
    root.append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({
      title: 'No support requests', body: 'Nothing is waiting for a reply.',
    })])]));
    return root;
  }

  const body = el('tbody');
  for (const s of data.items) {
    body.append(el('tr', { class: 'clickable', onclick: () => go(`/support/${s.ref}`) }, [
      el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: s.ref })]),
      el('td', { class: 'primary', dataset: { label: 'Subject' }, text: s.subject }),
      el('td', { dataset: { label: 'User' } }, [
        el('div', { text: s.user.fullName }),
        el('div', { class: 'ref muted', text: s.user.publicId }),
      ]),
      el('td', { dataset: { label: 'Category' }, class: 'muted', text: statusLabel(s.category) }),
      el('td', { dataset: { label: 'Updated' }, class: 'muted', text: relative(s.updatedAt) }),
      el('td', { dataset: { label: 'Status' } }, [badge(s.status)]),
    ]));
  }

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Reference' }), el('th', { text: 'Subject' }), el('th', { text: 'User' }),
          el('th', { text: 'Category' }), el('th', { text: 'Updated' }), el('th', { text: 'Status' }),
        ])]),
        body,
      ]),
    ]),
  ]));
  return root;
}

export async function renderSupportThread([ref]) {
  const data = await api.get(`/api/admin/support/${encodeURIComponent(ref)}`);
  const root = el('div', { class: 'stack-6', style: 'max-width:820px' });

  root.append(el('a', { class: 'back-link', href: '#/support' }, [icon('chat', 14), el('span', { text: 'All requests' })]));
  root.append(el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [
        el('h2', { text: data.request.subject }),
        el('p', {}, [
          el('span', { class: 'ref', text: data.request.ref }),
          ` · ${data.user.fullName} (${data.user.publicId}) · ${data.user.phone}`,
        ]),
      ]),
      badge(data.request.status),
    ]),
  ]));

  const thread = el('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:var(--s-4)' },
    data.messages.map((m) => el('div', {
      style: `border:1px solid var(--ink-200);border-radius:var(--r-md);padding:var(--s-4);${
        m.authorType === 'admin' ? 'background:var(--brand-50);border-color:var(--brand-100)' : ''}`,
    }, [
      el('div', { class: 'row between', style: 'margin-bottom:var(--s-2)' }, [
        el('strong', { style: 'font-size:var(--t-base)', text: m.authorType === 'admin' ? `${m.author} · staff` : `${data.user.fullName} · user` }),
        el('span', { class: 'muted', style: 'font-size:var(--t-xs)', text: dateTime(m.at) }),
      ]),
      el('div', { style: 'font-size:var(--t-base);white-space:pre-wrap', text: m.body }),
    ])));

  const replyForm = el('form', { novalidate: true }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'message', text: 'Reply' }),
      el('textarea', { class: 'textarea', id: 'message', rows: '4', maxlength: '4000' }),
    ]),
    el('div', { class: 'row' }, [
      el('select', { class: 'select', id: 'next-status', style: 'max-width:220px' }, [
        el('option', { value: 'answered', text: 'Mark answered' }),
        el('option', { value: 'pending_user', text: 'Awaiting the user' }),
        el('option', { value: 'closed', text: 'Close the request' }),
      ]),
      el('button', { class: 'btn btn-primary', type: 'submit', id: 'reply-submit', text: 'Send reply' }),
    ]),
  ]);

  replyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const restore = busy($('#reply-submit'), 'Sending…');
    try {
      await api.post(`/api/admin/support/${encodeURIComponent(ref)}/reply`, {
        message: replyForm.querySelector('#message').value,
        status: replyForm.querySelector('#next-status').value,
      });
      toast('Reply sent.', 'pos');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) { restore(); toast(error.message, 'neg'); }
  });

  root.append(el('div', { class: 'card' }, [
    thread,
    can('support.respond')
      ? el('div', { class: 'card-footer', style: 'background:var(--white)' }, [replyForm])
      : el('div', { class: 'card-footer', text: 'Your role can read support requests but not reply.' }),
  ]));
  return root;
}
