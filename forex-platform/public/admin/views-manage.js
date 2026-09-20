/*
 * User management, platform configuration, content, audit log and
 * administrator accounts.
 */
import { api, ApiError } from '/assets/js/api.js';
import {
  el, clear, $, toast, emptyState, busy, confirmDialog, applyFieldErrors, clearFieldErrors,
} from '/assets/js/ui.js';
import { money, dateTime, dateOnly, relative, statusTone, statusLabel, titleCase } from '/assets/js/format.js';
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

/* ===========================================================================
   Users
   =========================================================================== */
export async function renderUsers() {
  const root = el('div', { class: 'stack-6' });
  root.append(head('Users', 'Search by account ID, name, email or phone number.'));

  const bar = el('div', { class: 'filters' });
  const listCard = el('div', { class: 'card' });
  let status = '';
  let query = '';

  async function load() {
    clear(listCard).append(el('div', { class: 'card-body' }, [
      el('div', { class: 'skeleton skeleton-line', style: 'width:100%' }),
      el('div', { class: 'skeleton skeleton-line', style: 'width:80%' }),
    ]));
    const params = new URLSearchParams({ limit: '50' });
    if (status) params.set('status', status);
    if (query) params.set('q', query);
    const data = await api.get(`/api/admin/users?${params}`);

    if (!bar.childElementCount) {
      bar.append(
        el('label', { class: 'visually-hidden', for: 'q', text: 'Search users' }),
        el('input', {
          class: 'input search', type: 'search', id: 'q', placeholder: 'USR-…, name, email or phone',
          onkeydown: (e) => { if (e.key === 'Enter') { query = e.target.value; load(); } },
        }),
        el('label', { class: 'visually-hidden', for: 'status', text: 'Filter by status' }),
        el('select', {
          class: 'select', id: 'status', style: 'max-width:220px',
          onchange: (e) => { status = e.target.value; load(); },
        }, [
          el('option', { value: '', text: 'All statuses' }),
          ...data.statuses.map((s) => el('option', { value: s, text: statusLabel(s) })),
        ]),
      );
    }

    if (!data.items.length) {
      clear(listCard).append(el('div', { class: 'card-body' }, [emptyState({
        title: 'No accounts match', body: 'Try a different search term or clear the status filter.',
      })]));
      return;
    }

    const body = el('tbody');
    for (const u of data.items) {
      body.append(el('tr', { class: 'clickable', onclick: () => go(`/users/${u.publicId}`) }, [
        el('td', { dataset: { label: 'Account' } }, [
          el('div', { class: 'primary', text: u.fullName }),
          el('div', { class: 'ref muted', text: u.publicId }),
        ]),
        el('td', { dataset: { label: 'Phone' }, class: 'muted', text: u.phone }),
        el('td', { class: 'num', dataset: { label: 'Available' }, text: money(u.availableCents) }),
        el('td', { class: 'num', dataset: { label: 'Invested' }, text: money(u.investedCents) }),
        el('td', { dataset: { label: 'Flags' } }, [
          u.openFlags > 0
            ? el('span', { class: 'badge badge-warn', text: `${u.openFlags} open` })
            : el('span', { class: 'muted', text: '—' }),
        ]),
        el('td', { dataset: { label: 'Joined' }, class: 'muted', text: dateOnly(u.createdAt) }),
        el('td', { dataset: { label: 'Status' } }, [badge(u.status)]),
      ]));
    }

    clear(listCard).append(
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data stackable' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Account' }), el('th', { text: 'Phone' }), el('th', { class: 'num', text: 'Available' }),
            el('th', { class: 'num', text: 'Invested' }), el('th', { text: 'Flags' }),
            el('th', { text: 'Joined' }), el('th', { text: 'Status' }),
          ])]),
          body,
        ]),
      ]),
      el('div', { class: 'card-footer', text: `${data.items.length} of ${data.total} accounts.` }),
    );
  }

  root.append(bar, listCard);
  await load();
  return root;
}

const STATUS_ACTIONS = [
  ['review', 'Place under review', 'secondary'],
  ['restrict', 'Restrict', 'secondary'],
  ['suspend', 'Suspend', 'danger'],
  ['ban', 'Ban', 'danger'],
  ['restore', 'Restore to normal', 'success'],
];

export async function renderUserDetail([publicId]) {
  const data = await api.get(`/api/admin/users/${encodeURIComponent(publicId)}`);
  const u = data.user;
  const root = el('div', { class: 'stack-6' });

  root.append(el('a', { class: 'back-link', href: '#/users' }, [icon('users', 14), el('span', { text: 'All users' })]));
  root.append(el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [
        el('h2', { text: u.fullName }),
        el('p', {}, [
          el('span', { class: 'ref', text: u.publicId }), ` · ${u.phone} · ${u.email} · joined ${dateOnly(u.createdAt)}`,
        ]),
      ]),
      badge(u.status),
    ]),
  ]));

  if (u.statusReason) {
    root.append(el('div', { class: 'notice notice-warn' }, [
      el('div', {}, [el('strong', { text: 'Reason on file' }), el('span', { text: u.statusReason })]),
    ]));
  }

  const b = data.balances;
  root.append(el('div', { class: 'stat-grid' }, [
    el('div', { class: 'stat accent' }, [
      el('div', { class: 'stat-label', text: 'Total balance' }),
      el('div', { class: 'stat-value sm', text: money(b.totalCents) }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: 'Available' }),
      el('div', { class: 'stat-value sm', text: money(b.availableCents) }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: 'Invested' }),
      el('div', { class: 'stat-value sm', text: money(b.investedCents) }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: 'Realised profit' }),
      el('div', { class: 'stat-value sm', text: money(b.realizedProfitCents) }),
    ]),
  ]));

  /* -- Tabs -------------------------------------------------------------- */
  const panes = {};
  const paneHost = el('div');
  const tabs = el('div', { class: 'pill-tabs', role: 'tablist' });

  function addTab(key, label, node) {
    panes[key] = node;
    const button = el('button', {
      type: 'button', role: 'tab', text: label, 'aria-selected': 'false',
      onclick: () => {
        [...tabs.children].forEach((c) => c.setAttribute('aria-selected', String(c === button)));
        clear(paneHost).append(node);
      },
    });
    tabs.append(button);
  }

  const table = (headers, rows) => el('div', { class: 'card' }, [
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { class: h.num ? 'num' : null, text: h.label })))]),
        el('tbody', {}, rows),
      ]),
    ]),
  ]);

  addTab('deposits', `Deposits (${data.deposits.length})`,
    data.deposits.length
      ? table([{ label: 'Reference' }, { label: 'Amount', num: true }, { label: 'Method' }, { label: 'Submitted' }, { label: 'Status' }],
        data.deposits.map((d) => el('tr', { class: 'clickable', onclick: () => go(`/deposits/${d.ref}`) }, [
          el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: d.ref })]),
          el('td', { class: 'num primary', dataset: { label: 'Amount' }, text: money(d.amountCents) }),
          el('td', { dataset: { label: 'Method' }, text: d.method || '—' }),
          el('td', { dataset: { label: 'Submitted' }, class: 'muted', text: dateOnly(d.createdAt) }),
          el('td', { dataset: { label: 'Status' } }, [badge(d.status)]),
        ])))
      : el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({ title: 'No deposits' })])]));

  addTab('withdrawals', `Withdrawals (${data.withdrawals.length})`,
    data.withdrawals.length
      ? table([{ label: 'Reference' }, { label: 'Amount', num: true }, { label: 'To' }, { label: 'Requested' }, { label: 'Status' }],
        data.withdrawals.map((w) => el('tr', { class: 'clickable', onclick: () => go(`/withdrawals/${w.ref}`) }, [
          el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: w.ref })]),
          el('td', { class: 'num primary', dataset: { label: 'Amount' }, text: money(w.amountCents) }),
          el('td', { dataset: { label: 'To' }, class: 'mono muted', text: w.payoutAccountMasked }),
          el('td', { dataset: { label: 'Requested' }, class: 'muted', text: dateOnly(w.createdAt) }),
          el('td', { dataset: { label: 'Status' } }, [badge(w.status)]),
        ])))
      : el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({ title: 'No withdrawals' })])]));

  addTab('ledger', `Ledger (${data.transactions.length})`,
    data.transactions.length
      ? table([{ label: 'Reference' }, { label: 'Type' }, { label: 'Amount', num: true }, { label: 'Posted' }, { label: 'Status' }],
        data.transactions.map((t) => el('tr', {}, [
          el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: t.ref })]),
          el('td', { dataset: { label: 'Type' }, text: statusLabel(t.type) }),
          el('td', {
            class: 'num', dataset: { label: 'Amount' },
            style: `color:var(--${t.direction === 'credit' ? 'pos-700' : 'ink-900'})`,
            text: `${t.direction === 'credit' ? '+' : '−'}${money(t.amountCents)}`,
          }),
          el('td', { dataset: { label: 'Posted' }, class: 'muted', text: dateTime(t.createdAt) }),
          el('td', { dataset: { label: 'Status' }, class: 'muted', text: titleCase(t.status) }),
        ])))
      : el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({ title: 'No ledger entries' })])]));

  addTab('investments', `Investments (${data.investments.length})`,
    data.investments.length
      ? table([{ label: 'Reference' }, { label: 'Principal', num: true }, { label: 'Example daily', num: true }, { label: 'Opened' }, { label: 'Status' }],
        data.investments.map((i) => el('tr', {}, [
          el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: i.ref })]),
          el('td', { class: 'num primary', dataset: { label: 'Principal' }, text: money(i.principalCents) }),
          el('td', { class: 'num muted', dataset: { label: 'Example daily' }, text: money(i.illustrative.dailyCents) }),
          el('td', { dataset: { label: 'Opened' }, class: 'muted', text: dateOnly(i.openedAt) }),
          el('td', { dataset: { label: 'Status' } }, [badge(i.status)]),
        ])))
      : el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({ title: 'No investments' })])]));

  addTab('devices', `Devices (${data.devices.length})`,
    data.devices.length
      ? el('div', { class: 'card' }, [
        el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data stackable' }, [
            el('thead', {}, [el('tr', {}, [
              el('th', { text: 'Device' }), el('th', { text: 'Last IP' }), el('th', { text: 'Seen' }),
              el('th', { text: 'First seen' }), el('th', { text: 'Other accounts' }),
            ])]),
            el('tbody', {}, data.devices.map((d) => el('tr', {}, [
              el('td', { dataset: { label: 'Device' } }, [
                el('div', { class: 'mono', text: d.hash }),
                el('div', { class: 'muted', style: 'font-size:var(--t-xs)', text: `${d.platform || 'unknown'} · ${d.timezone || 'unknown tz'}` }),
              ]),
              el('td', { dataset: { label: 'Last IP' }, class: 'mono muted', text: d.lastSeenIp || '—' }),
              el('td', { class: 'num', dataset: { label: 'Seen' }, text: String(d.seenCount) }),
              el('td', { dataset: { label: 'First seen' }, class: 'muted', text: dateOnly(d.firstSeenAt) }),
              el('td', { dataset: { label: 'Other accounts' } }, [
                d.accountsOnDevice > 1
                  ? el('span', { class: 'badge badge-warn', text: `${d.accountsOnDevice - 1} other` })
                  : el('span', { class: 'muted', text: 'None seen' }),
              ]),
            ]))),
          ]),
        ]),
        el('div', { class: 'card-footer', text: 'Device signals are approximate. They collide between different people on similar setups and change for the same person over time — treat a match as a prompt to check, never as proof.' }),
      ])
      : el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({ title: 'No device signals recorded' })])]));

  if (data.riskFlags.length) {
    addTab('flags', `Risk flags (${data.riskFlags.length})`,
      table([{ label: 'Type' }, { label: 'Severity' }, { label: 'Matched with' }, { label: 'Raised' }, { label: 'Status' }],
        data.riskFlags.map((f) => el('tr', {}, [
          el('td', { class: 'primary', dataset: { label: 'Type' }, text: statusLabel(f.type) }),
          el('td', { dataset: { label: 'Severity' }, text: titleCase(f.severity) }),
          el('td', { dataset: { label: 'Matched with' }, class: 'ref muted', text: f.relatedUser || '—' }),
          el('td', { dataset: { label: 'Raised' }, class: 'muted', text: relative(f.createdAt) }),
          el('td', { dataset: { label: 'Status' } }, [badge(f.status)]),
        ]))));
  }

  tabs.firstChild?.click();

  /* -- Side panel -------------------------------------------------------- */
  const side = el('div', { class: 'stack-4' });

  if (data.kyc) {
    const valueNode = el('dd', { class: 'mono', text: data.kyc.masked });
    side.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('h3', { text: 'Identity document' }), el('div', { class: 'sub', text: 'Masked by default' })]),
        badge(data.kyc.status),
      ]),
      el('div', { class: 'card-body' }, [
        el('dl', { class: 'deflist' }, [
          el('div', { class: 'defrow' }, [el('dt', { text: 'Number' }), valueNode]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Name on document' }), el('dd', { text: data.kyc.nameOnId || '—' })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Submitted' }), el('dd', { text: dateOnly(data.kyc.submittedAt) })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Consent given' }), el('dd', { text: dateOnly(data.kyc.consentAt) })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Delete by' }), el('dd', { text: dateOnly(data.kyc.retentionUntil) })]),
        ]),
        data.kyc.canReveal
          ? el('button', {
            class: 'btn btn-secondary btn-sm btn-block', type: 'button', style: 'margin-top:var(--s-4)',
            text: 'Reveal full number',
            onclick: async (event) => {
              const reason = await confirmDialog({
                title: 'Reveal the full document number?',
                body: 'This is recorded in the audit log against your administrator account, with the reason you give below.',
                confirmLabel: 'Reveal', requireNote: true, noteLabel: 'Why do you need to see it?',
                notePlaceholder: 'e.g. Reconciling a payment where the sender name does not match.',
              });
              if (!reason) return;
              try {
                const result = await api.post(`/api/admin/users/${encodeURIComponent(publicId)}/kyc/reveal`, { reason });
                valueNode.textContent = result.value;
                event.target.remove();
                toast('Revealed. This access has been logged.', 'warn', 8000);
              } catch (error) { toast(error.message, 'neg'); }
            },
          })
          : el('p', { class: 'hint', style: 'margin-top:var(--s-3)', text: 'Your role cannot reveal the full number.' }),
        data.kyc.imageUrl
          ? el('div', { class: 'evidence-frame', style: 'margin-top:var(--s-4)' }, [
            el('img', { src: data.kyc.imageUrl, alt: 'Identity document image', loading: 'lazy' }),
          ])
          : null,
        can('kyc.review')
          ? el('div', { class: 'row', style: 'gap:var(--s-2);margin-top:var(--s-4)' }, [
            el('button', { class: 'btn btn-success btn-sm', type: 'button', text: 'Approve',
              onclick: () => reviewKyc('approved', 'Approve this identity document?') }),
            el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Reject',
              onclick: () => reviewKyc('rejected', 'Reject this identity document?') }),
          ])
          : null,
      ]),
    ]));
  }

  async function reviewKyc(decision, title) {
    const note = await confirmDialog({
      title, confirmLabel: decision === 'approved' ? 'Approve' : 'Reject',
      tone: decision === 'approved' ? 'success' : 'danger',
      body: 'The user is notified of the outcome and sees the note you write here.',
      requireNote: decision === 'rejected', noteLabel: 'Reason for the user',
      notePlaceholder: 'e.g. The image is too blurred to read the number.',
    });
    if (!note) return;
    try {
      await api.post(`/api/admin/users/${encodeURIComponent(publicId)}/kyc/review`, {
        decision, note: typeof note === 'string' ? note : null,
      });
      toast('Identity review recorded.', 'pos');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) { toast(error.message, 'neg'); }
  }

  if (can('users.manage')) {
    side.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Account status' })]),
      el('div', { class: 'card-body' }, [
        el('p', { class: 'hint', style: 'margin-bottom:var(--s-4)', text: 'Every change here is written to the audit log with your reason and notifies the user.' }),
        el('div', { class: 'row', style: 'gap:var(--s-2)' }, STATUS_ACTIONS.map(([action, label, tone]) => el('button', {
          class: `btn btn-${tone} btn-sm`, type: 'button', text: label,
          onclick: async () => {
            const reason = await confirmDialog({
              title: `${label} ${u.publicId}?`,
              body: action === 'ban'
                ? 'The account is closed, all its sessions are ended, and the user can no longer sign in. Their records and ledger are retained.'
                : action === 'suspend'
                  ? 'All sessions are ended and the user cannot transact. Their records remain intact.'
                  : action === 'restore'
                    ? 'The account returns to normal (or back to phone verification if it was never verified).'
                    : 'The user keeps read access to their records but cannot transact.',
              confirmLabel: label, tone: tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : 'primary',
              requireNote: true, noteLabel: 'Reason (recorded and shown to the user)',
            });
            if (!reason) return;
            try {
              await api.post(`/api/admin/users/${encodeURIComponent(publicId)}/status`, { action, reason });
              toast('Account status updated.', 'pos');
              window.dispatchEvent(new HashChangeEvent('hashchange'));
            } catch (error) { toast(error.message, 'neg'); }
          },
        }))),
      ]),
    ]));
  }

  if (can('ledger.adjust')) {
    const adjForm = el('form', { novalidate: true, id: 'adjust-form' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'type', text: 'Entry type' }),
        el('select', { class: 'select', id: 'type', name: 'type' }, [
          el('option', { value: 'profit_credit', text: 'Realised profit (credit)' }),
          el('option', { value: 'adjustment_credit', text: 'Correction (credit)' }),
          el('option', { value: 'adjustment_debit', text: 'Correction (debit)' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'amount', text: 'Amount' }),
        el('div', { class: 'input-money' }, [
          el('input', { class: 'input', type: 'text', inputmode: 'decimal', id: 'amount', name: 'amount', placeholder: '0.00' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'reason', text: 'Reason' }),
        el('textarea', { class: 'textarea', id: 'reason', name: 'reason', rows: '3',
          placeholder: 'At least 12 characters. This is permanent and appears in the audit log.' }),
      ]),
      el('div', { id: 'adjust-error' }),
      el('button', { class: 'btn btn-primary btn-block', type: 'submit', id: 'adjust-submit', text: 'Post ledger entry' }),
    ]);

    adjForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(adjForm);
      clear($('#adjust-error'));
      const ok = await confirmDialog({
        title: 'Post this ledger entry?',
        body: 'Ledger entries are permanent. If this is wrong it can only be corrected by posting a second, opposite entry — history is never edited.',
        confirmLabel: 'Post entry',
        checkboxLabel: 'I confirm this entry is correct and the reason above explains it.',
      });
      if (!ok) return;
      const restore = busy($('#adjust-submit'), 'Posting…');
      try {
        const result = await api.post(`/api/admin/users/${encodeURIComponent(publicId)}/adjust`, {
          type: adjForm.querySelector('#type').value,
          amount: adjForm.querySelector('#amount').value,
          reason: adjForm.querySelector('#reason').value,
        });
        toast(`Posted ${result.transaction}.`, 'pos');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (error) {
        restore();
        if (error instanceof ApiError && error.fields && applyFieldErrors(adjForm, error.fields)) return;
        clear($('#adjust-error')).append(el('div', {
          class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
        }, [el('div', { text: error.message })]));
      }
    });

    side.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('h3', { text: 'Ledger adjustment' }), el('div', { class: 'sub', text: 'Permanent and audited' })]),
      ]),
      el('div', { class: 'card-body' }, [adjForm]),
    ]));
  }

  if (can('users.notes')) {
    const noteForm = el('form', { novalidate: true }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'note-body', text: 'Internal note' }),
        el('textarea', { class: 'textarea', id: 'note-body', rows: '3', placeholder: 'Only staff can see this. The user cannot.' }),
      ]),
      el('button', { class: 'btn btn-secondary btn-block', type: 'submit', id: 'note-submit', text: 'Add note' }),
    ]);
    noteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const restore = busy($('#note-submit'), 'Saving…');
      try {
        await api.post(`/api/admin/users/${encodeURIComponent(publicId)}/notes`, {
          body: noteForm.querySelector('#note-body').value,
        });
        toast('Note added.', 'pos');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (error) { restore(); toast(error.message, 'neg'); }
    });

    side.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: `Internal notes (${data.notes.length})` })]),
      el('div', { class: 'card-body' }, [
        ...data.notes.slice(0, 5).map((n) => el('div', { style: 'border-bottom:1px solid var(--ink-100);padding-bottom:var(--s-3);margin-bottom:var(--s-3)' }, [
          el('div', { style: 'font-size:var(--t-base)', text: n.body }),
          el('div', { class: 'muted', style: 'font-size:var(--t-xs);margin-top:4px', text: `${n.admin} · ${dateTime(n.at)}` }),
        ])),
        noteForm,
      ]),
    ]));
  }

  root.append(el('div', { class: 'review-layout' }, [
    el('div', { class: 'stack-4' }, [tabs, paneHost]),
    side,
  ]));
  return root;
}

/* ===========================================================================
   Settings
   =========================================================================== */
export async function renderSettings() {
  const data = await api.get('/api/admin/settings');
  const root = el('div', { class: 'stack-6' });
  root.append(head(
    'Settings',
    'Everything the platform reads at runtime. Changing a value here changes the public site, the calculator and the workflows immediately — no deploy required.',
  ));

  if (!data.canEdit) {
    root.append(el('div', { class: 'notice notice-neutral' }, [
      el('div', { text: 'Your role can view settings but not change them.' }),
    ]));
  }

  for (const group of data.groups) {
    const rows = group.items.map((item) => {
      const inputId = `set-${item.key}`;
      let control;
      if (item.type === 'bool') {
        control = el('select', { class: 'select', id: inputId, disabled: !data.canEdit }, [
          el('option', { value: '1', text: 'On', selected: item.parsed === true }),
          el('option', { value: '0', text: 'Off', selected: item.parsed !== true }),
        ]);
      } else if (item.type === 'text') {
        control = el('textarea', { class: 'textarea', id: inputId, rows: '4', disabled: !data.canEdit, text: item.value });
      } else if (item.type === 'money') {
        control = el('div', { class: 'input-money' }, [
          el('input', { class: 'input', id: inputId, type: 'text', inputmode: 'decimal',
            value: (Number(item.value) / 100).toFixed(2), disabled: !data.canEdit }),
        ]);
      } else {
        control = el('input', { class: 'input', id: inputId, type: 'text', value: item.value, disabled: !data.canEdit });
      }

      const save = el('button', {
        class: 'btn btn-secondary btn-sm', type: 'button', text: 'Save',
        disabled: !data.canEdit,
        onclick: async (event) => {
          const node = document.getElementById(inputId);
          const value = node.value;
          const restore = busy(event.target, '…');
          try {
            const result = await api.put('/api/admin/settings', { key: item.key, value, reason: null });
            restore();
            toast(result.changed ? `${item.label} updated.` : 'No change.', result.changed ? 'pos' : 'info', 2500);
          } catch (error) {
            restore();
            toast(error.message, 'neg', 8000);
          }
        },
      });

      return el('div', { class: 'field', style: 'padding-bottom:var(--s-5);border-bottom:1px solid var(--ink-100)' }, [
        el('label', { class: 'label', for: inputId, text: item.label }),
        item.help ? el('p', { class: 'hint', style: 'margin:0 0 8px', text: item.help }) : null,
        el('div', { class: 'row', style: 'align-items:flex-start' }, [
          el('div', { style: 'flex:1;min-width:240px' }, [control]),
          save,
        ]),
        el('p', { class: 'hint', style: 'margin-top:6px', text: `Key: ${item.key} · last changed ${relative(item.updatedAt)}` }),
      ]);
    });

    root.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: group.label })]),
      el('div', { class: 'card-body' }, rows),
    ]));
  }

  return root;
}

/* ===========================================================================
   Payment methods
   =========================================================================== */
export async function renderPayments() {
  const data = await api.get('/api/admin/payment-methods');
  const root = el('div', { class: 'stack-6' });
  root.append(head(
    'Payment methods',
    'The receiving accounts shown to users on the deposit page, and the payout options offered on withdrawal. Nothing is hard-coded in the frontend.',
  ));

  if (!data.canEdit) {
    root.append(el('div', { class: 'notice notice-neutral' }, [
      el('div', { text: 'Your role can view payment methods but not change them.' }),
    ]));
  }

  for (const m of data.items) {
    const form = el('form', { novalidate: true, id: `pm-${m.id}` }, [
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'field' }, [
          el('label', { class: 'label', for: `pm-name-${m.id}`, text: 'Display name' }),
          el('input', { class: 'input', id: `pm-name-${m.id}`, name: 'name', value: m.name, disabled: !data.canEdit }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'label', for: `pm-title-${m.id}`, text: 'Account title' }),
          el('input', { class: 'input', id: `pm-title-${m.id}`, name: 'account_title', value: m.accountTitle || '', disabled: !data.canEdit }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: `pm-num-${m.id}`, text: 'Receiving account number' }),
        el('input', { class: 'input', id: `pm-num-${m.id}`, name: 'account_number', value: m.accountNumber || '', disabled: !data.canEdit }),
        el('p', { class: 'hint', text: 'This is the number users are told to send money to. Check it character by character before saving.' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: `pm-inst-${m.id}`, text: 'Instructions' }),
        el('textarea', { class: 'textarea', id: `pm-inst-${m.id}`, name: 'instructions', rows: '3', disabled: !data.canEdit, text: m.instructions || '' }),
      ]),
      el('div', { class: 'row' }, [
        el('label', { class: 'checkline', style: 'margin:0' }, [
          el('input', { type: 'checkbox', id: `pm-dep-${m.id}`, checked: m.forDeposit, disabled: !data.canEdit }),
          el('span', { text: 'Accept deposits' }),
        ]),
        el('label', { class: 'checkline', style: 'margin:0' }, [
          el('input', { type: 'checkbox', id: `pm-wd-${m.id}`, checked: m.forWithdrawal, disabled: !data.canEdit }),
          el('span', { text: 'Offer for payouts' }),
        ]),
        el('label', { class: 'checkline', style: 'margin:0' }, [
          el('input', { type: 'checkbox', id: `pm-act-${m.id}`, checked: m.isActive, disabled: !data.canEdit }),
          el('span', { text: 'Active' }),
        ]),
      ]),
      el('div', { id: `pm-error-${m.id}` }),
      data.canEdit
        ? el('button', { class: 'btn btn-primary', type: 'submit', id: `pm-save-${m.id}`, text: 'Save changes' })
        : null,
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(form);
      clear($(`#pm-error-${m.id}`));
      const accountNumber = form.querySelector(`#pm-num-${m.id}`).value.trim();
      const ok = await confirmDialog({
        title: `Update ${m.name}?`,
        body: el('div', {}, [
          el('p', { class: 'muted', text: 'This is what every user is told to send money to. A wrong digit here sends real payments to the wrong account.' }),
          el('div', { class: 'notice notice-warn', style: 'margin-top:var(--s-4)' }, [
            el('div', {}, [
              el('strong', { text: 'New receiving account' }),
              el('span', { class: 'mono', text: accountNumber || '(empty)' }),
            ]),
          ]),
        ]),
        confirmLabel: 'Save', checkboxLabel: 'I have checked this account number digit by digit.',
      });
      if (!ok) return;

      const restore = busy($(`#pm-save-${m.id}`), 'Saving…');
      try {
        await api.put(`/api/admin/payment-methods/${m.id}`, {
          name: form.querySelector(`#pm-name-${m.id}`).value,
          account_title: form.querySelector(`#pm-title-${m.id}`).value,
          account_number: accountNumber,
          instructions: form.querySelector(`#pm-inst-${m.id}`).value,
          for_deposit: form.querySelector(`#pm-dep-${m.id}`).checked,
          for_withdrawal: form.querySelector(`#pm-wd-${m.id}`).checked,
          is_active: form.querySelector(`#pm-act-${m.id}`).checked,
        });
        restore();
        toast(`${m.name} updated.`, 'pos');
      } catch (error) {
        restore();
        if (error instanceof ApiError && error.fields && applyFieldErrors(form, error.fields)) return;
        clear($(`#pm-error-${m.id}`)).append(el('div', {
          class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
        }, [el('div', { text: error.message })]));
      }
    });

    root.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('h3', { text: m.name }), el('div', { class: 'sub', text: `Key: ${m.key} · updated ${relative(m.updatedAt)}` })]),
        el('span', { class: `badge badge-${m.isActive ? 'pos' : 'neutral'}`, text: m.isActive ? 'Active' : 'Inactive' }),
      ]),
      el('div', { class: 'card-body' }, [form]),
    ]));
  }

  return root;
}

/* ===========================================================================
   Content & legal
   =========================================================================== */
export async function renderContent() {
  const data = await api.get('/api/admin/content');
  const root = el('div', { class: 'stack-6' });
  root.append(head('Content & legal', 'Homepage copy, the risk disclosure and the legal documents, exactly as visitors see them.'));

  root.append(el('div', { class: 'notice notice-warn' }, [
    el('div', {}, [
      el('strong', { text: 'Be careful with the risk copy' }),
      el('span', { text: 'The risk disclosure and the illustrative-calculation wording are what keep this platform honest about what it is offering. Do not weaken them, and never describe an illustrative figure as a guaranteed or fixed return.' }),
    ]),
  ]));

  for (const block of data.items) {
    const textarea = el('textarea', {
      class: 'textarea', id: `content-${block.key}`, rows: '12',
      disabled: !data.canEdit, text: block.body,
      style: 'font-family:var(--font-mono);font-size:var(--t-sm);line-height:1.6',
    });
    root.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('h3', { text: block.title }), el('div', { class: 'sub', text: `Key: ${block.key} · updated ${relative(block.updatedAt)}` })]),
        data.canEdit
          ? el('button', {
            class: 'btn btn-secondary btn-sm', type: 'button', text: 'Save',
            onclick: async (event) => {
              const restore = busy(event.target, '…');
              try {
                await api.put(`/api/admin/content/${encodeURIComponent(block.key)}`, {
                  body: textarea.value, reason: null,
                });
                restore();
                toast(`${block.title} saved.`, 'pos');
              } catch (error) { restore(); toast(error.message, 'neg'); }
            },
          })
          : null,
      ]),
      el('div', { class: 'card-body' }, [
        textarea,
        el('p', { class: 'hint', text: 'Markdown headings (##), bullet lists and paragraphs are rendered. Everything is escaped before display — raw HTML is never executed.' }),
      ]),
    ]));
  }
  return root;
}

/* ===========================================================================
   Audit log
   =========================================================================== */
export async function renderAudit() {
  const root = el('div', { class: 'stack-6' });
  root.append(head('Audit log', 'Append-only. No role, including Super Admin, can edit or delete an entry.'));

  const bar = el('div', { class: 'filters' });
  const listCard = el('div', { class: 'card' });
  let action = '';
  let actor = '';

  async function load() {
    clear(listCard).append(el('div', { class: 'card-body' }, [
      el('div', { class: 'skeleton skeleton-line', style: 'width:100%' }),
      el('div', { class: 'skeleton skeleton-line', style: 'width:80%' }),
    ]));
    const params = new URLSearchParams({ limit: '100' });
    if (action) params.set('action', action);
    if (actor) params.set('actor', actor);
    const data = await api.get(`/api/admin/audit?${params}`);

    if (!bar.childElementCount) {
      bar.append(
        el('label', { class: 'visually-hidden', for: 'actor', text: 'Filter by actor' }),
        el('input', {
          class: 'input search', type: 'search', id: 'actor', placeholder: 'Actor (USR-…, ADM-…)',
          onkeydown: (e) => { if (e.key === 'Enter') { actor = e.target.value; load(); } },
        }),
        el('label', { class: 'visually-hidden', for: 'action', text: 'Filter by action' }),
        el('select', {
          class: 'select', id: 'action', style: 'max-width:260px',
          onchange: (e) => { action = e.target.value; load(); },
        }, [
          el('option', { value: '', text: 'All actions' }),
          ...data.actions.map((a) => el('option', { value: a, text: a })),
        ]),
      );
    }

    if (!data.items.length) {
      clear(listCard).append(el('div', { class: 'card-body' }, [emptyState({
        title: 'No entries match', body: 'Try a different filter.',
      })]));
      return;
    }

    const body = el('tbody');
    for (const a of data.items) {
      body.append(el('tr', {}, [
        el('td', { dataset: { label: 'When' }, class: 'muted', text: dateTime(a.at) }),
        el('td', { dataset: { label: 'Actor' } }, [
          el('div', { class: 'ref', text: a.actor }),
          el('div', { class: 'muted', style: 'font-size:var(--t-xs)', text: a.actorRole || a.actorType }),
        ]),
        el('td', { class: 'primary mono', dataset: { label: 'Action' }, text: a.action }),
        el('td', { dataset: { label: 'Entity' }, class: 'muted', text: a.entity || '—' }),
        el('td', { dataset: { label: 'Change' }, style: 'max-width:340px' }, [
          a.previous ? el('div', { class: 'mono muted', style: 'font-size:var(--t-xs);word-break:break-word', text: `was ${a.previous}` }) : null,
          a.next ? el('div', { class: 'mono', style: 'font-size:var(--t-xs);word-break:break-word', text: `now ${a.next}` }) : null,
          a.reason ? el('div', { style: 'font-size:var(--t-xs);margin-top:2px', text: a.reason }) : null,
        ]),
        el('td', { dataset: { label: 'IP' }, class: 'mono muted', text: a.ip || '—' }),
      ]));
    }

    clear(listCard).append(
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data stackable' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'When' }), el('th', { text: 'Actor' }), el('th', { text: 'Action' }),
            el('th', { text: 'Entity' }), el('th', { text: 'Change' }), el('th', { text: 'IP' }),
          ])]),
          body,
        ]),
      ]),
      el('div', { class: 'card-footer', text: `${data.items.length} of ${data.total} entries. ${data.note}` }),
    );
  }

  root.append(bar, listCard);
  await load();
  return root;
}

/* ===========================================================================
   Administrators
   =========================================================================== */
export async function renderAdmins() {
  const data = await api.get('/api/admin/admins');
  const root = el('div', { class: 'stack-6' });
  root.append(head('Administrators', 'Accounts and the permissions each role carries. There is no unlimited shared login.'));

  const body = el('tbody');
  for (const a of data.items) {
    body.append(el('tr', {}, [
      el('td', { dataset: { label: 'Name' } }, [
        el('div', { class: 'primary', text: a.name }),
        el('div', { class: 'ref muted', text: a.publicId }),
      ]),
      el('td', { dataset: { label: 'Email' }, class: 'muted', text: a.email }),
      el('td', { dataset: { label: 'Role' } }, [el('span', { class: 'badge badge-info', text: a.roleName })]),
      el('td', { dataset: { label: 'Last sign-in' }, class: 'muted', text: a.lastLoginAt ? relative(a.lastLoginAt) : 'never' }),
      el('td', { dataset: { label: 'Status' } }, [
        a.mustChangePassword ? el('span', { class: 'badge badge-warn', text: 'Password not set' }) : badge(a.status),
      ]),
      el('td', { dataset: { label: '' } }, [
        a.isSelf ? el('span', { class: 'muted', text: 'You' }) : el('button', {
          class: 'btn btn-secondary btn-sm', type: 'button',
          text: a.status === 'active' ? 'Disable' : 'Enable',
          onclick: async () => {
            const next = a.status === 'active' ? 'disabled' : 'active';
            const reason = await confirmDialog({
              title: `${next === 'disabled' ? 'Disable' : 'Enable'} ${a.name}?`,
              body: next === 'disabled'
                ? 'All of their console sessions end immediately and they can no longer sign in.'
                : 'They will be able to sign in to the console again.',
              confirmLabel: next === 'disabled' ? 'Disable' : 'Enable',
              tone: next === 'disabled' ? 'danger' : 'success',
              requireNote: true, noteLabel: 'Reason', noteMinLength: 4,
            });
            if (!reason) return;
            try {
              await api.post(`/api/admin/admins/${encodeURIComponent(a.publicId)}/status`, { status: next, reason });
              toast('Administrator updated.', 'pos');
              window.dispatchEvent(new HashChangeEvent('hashchange'));
            } catch (error) { toast(error.message, 'neg'); }
          },
        }),
      ]),
    ]));
  }

  const createForm = el('form', { novalidate: true, id: 'admin-create' }, [
    el('div', { class: 'grid-2' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'a-name', text: 'Name' }),
        el('input', { class: 'input', id: 'a-name', name: 'name' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'a-email', text: 'Email address' }),
        el('input', { class: 'input', id: 'a-email', name: 'email', type: 'email' }),
      ]),
    ]),
    el('div', { class: 'grid-2' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'a-role', text: 'Role' }),
        el('select', { class: 'select', id: 'a-role', name: 'role' },
          data.roles.map((r) => el('option', { value: r.key, text: `${r.name} (${r.permission_count} permissions)` }))),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'a-password', text: 'Temporary password' }),
        el('input', { class: 'input', id: 'a-password', name: 'password', type: 'text' }),
        el('p', { class: 'hint', text: 'At least 12 characters. They must replace it before they can use the console.' }),
      ]),
    ]),
    el('div', { id: 'a-error' }),
    el('button', { class: 'btn btn-primary', type: 'submit', id: 'a-submit', text: 'Create administrator' }),
  ]);

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(createForm);
    clear($('#a-error'));
    const restore = busy($('#a-submit'), 'Creating…');
    try {
      const result = await api.post('/api/admin/admins', {
        name: createForm.querySelector('#a-name').value,
        email: createForm.querySelector('#a-email').value,
        role: createForm.querySelector('#a-role').value,
        password: createForm.querySelector('#a-password').value,
      });
      toast(`Created ${result.publicId}. Give them the temporary password in person, not by message.`, 'pos', 9000);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(createForm, error.fields)) return;
      clear($('#a-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [el('h3', { text: 'Accounts' })]),
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Name' }), el('th', { text: 'Email' }), el('th', { text: 'Role' }),
          el('th', { text: 'Last sign-in' }), el('th', { text: 'Status' }), el('th', { text: '' }),
        ])]),
        body,
      ]),
    ]),
  ]));

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [el('h3', { text: 'Add an administrator' })]),
    el('div', { class: 'card-body' }, [createForm]),
  ]));

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [
      el('div', {}, [
        el('h3', { text: 'Roles and permissions' }),
        el('div', { class: 'sub', text: 'Checked on the server for every request, not just in this interface' }),
      ]),
    ]),
    el('div', { class: 'card-body' }, data.roles.map((r) => el('div', { style: 'padding-bottom:var(--s-5);margin-bottom:var(--s-5);border-bottom:1px solid var(--ink-100)' }, [
      el('h4', { style: 'font-size:var(--t-base);margin-bottom:4px', text: r.name }),
      el('p', { class: 'muted', style: 'font-size:var(--t-sm);margin-bottom:var(--s-3)', text: r.description }),
      el('div', { class: 'perm-grid' }, (data.permissionsByRole[r.key] || []).map((p) => el('span', { class: 'perm-chip', text: p }))),
    ]))),
  ]));

  return root;
}
