/*
 * Deposit, withdrawal, investment and transaction views.
 *
 * A recurring principle here: the screen never implies money has moved. A
 * submitted deposit is described as a claim awaiting verification, a
 * withdrawal request is described as a hold, and both say so in the copy as
 * well as in the badge.
 */
import { api, ApiError } from '/assets/js/api.js';
import {
  el, clear, $, toast, emptyState, applyFieldErrors, clearFieldErrors, busy, confirmDialog,
} from '/assets/js/ui.js';
import { money, dateTime, dateOnly, relative, statusTone, statusLabel } from '/assets/js/format.js';
import { icon } from './icons.js';
import { store, go } from './app.js';

const badgeFor = (status) => el('span', {
  class: `badge badge-${statusTone(status)}`, text: statusLabel(status),
});

function pageHead(title, description, action) {
  return el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [el('h2', { text: title }), el('p', { text: description })]),
      action || null,
    ]),
  ]);
}

function backLink(href, text) {
  return el('a', { class: 'back-link', href }, [icon('list', 14), el('span', { text })]);
}

function timeline(events) {
  if (!events.length) return el('p', { class: 'muted', text: 'No status changes recorded yet.' });
  return el('ol', { class: 'timeline' }, events.map((e) => el('li', {}, [
    el('div', { class: 't-title', text: statusLabel(e.to) }),
    el('div', { class: 't-meta', text: `${dateTime(e.at)} · ${e.actorType === 'user' ? 'you' : e.actorType === 'system' ? 'system' : 'our team'}` }),
    e.note ? el('div', { class: 't-note', text: e.note }) : null,
  ])));
}

/* ===========================================================================
   Deposits
   =========================================================================== */
export async function renderDepositForm() {
  const config = await api.get('/api/deposits/methods');
  const root = el('div', { class: 'stack-6' });

  root.append(pageHead(
    'Make a deposit',
    'Send the money first, then tell us about it. Your balance changes only after our team matches the payment against our receiving account records.',
  ));

  if (!config.enabled) {
    root.append(el('div', { class: 'notice notice-warn' }, [
      el('div', {}, [
        el('strong', { text: 'Deposits are paused' }),
        el('span', { text: 'New deposits are not being accepted at the moment. Please check back later or contact support.' }),
      ]),
    ]));
    return root;
  }

  const ready = config.methods.filter((m) => m.ready);
  if (!ready.length) {
    root.append(el('div', { class: 'notice notice-warn' }, [
      el('div', {}, [
        el('strong', { text: 'No payment method is configured' }),
        el('span', { text: 'Our team has not published a receiving account yet. Contact support before sending any money.' }),
      ]),
    ]));
    return root;
  }

  let selected = ready[0];

  const accountPanel = el('div', { class: 'card', style: 'background:var(--brand-50);border-color:var(--brand-100)' });
  function renderAccount() {
    clear(accountPanel).append(el('div', { class: 'card-body' }, [
      el('div', { class: 'stat-label', style: 'margin-bottom:var(--s-3)', text: `Send to — ${selected.name}` }),
      el('div', {
        style: 'font-size:var(--t-2xl);font-weight:650;letter-spacing:-0.02em;color:var(--brand-800);font-variant-numeric:tabular-nums',
        text: selected.accountNumber,
      }),
      selected.accountTitle ? el('div', { class: 'muted', style: 'font-size:var(--t-base);margin-top:4px', text: selected.accountTitle }) : null,
      el('button', {
        class: 'btn btn-secondary btn-sm', type: 'button', style: 'margin-top:var(--s-4)',
        text: 'Copy number',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(selected.accountNumber);
            toast('Account number copied.', 'pos', 2500);
          } catch { toast('Copy is not available in this browser — please type the number manually.', 'warn'); }
        },
      }),
      selected.instructions
        ? el('p', { class: 'hint', style: 'margin-top:var(--s-4)', text: selected.instructions })
        : null,
    ]));
  }
  renderAccount();

  const form = el('form', { novalidate: true, id: 'deposit-form' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'method_id', text: 'Payment method' }),
      el('select', { class: 'select', id: 'method_id', name: 'method_id' },
        ready.map((m) => el('option', { value: String(m.id), text: m.name }))),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'amount', text: 'Amount you sent' }),
      el('div', { class: 'input-money' }, [
        el('input', {
          class: 'input', type: 'text', inputmode: 'decimal', id: 'amount', name: 'amount',
          placeholder: '0.00', autocomplete: 'off',
        }),
      ]),
      el('p', { class: 'hint', text: `Between ${money(config.limits.minCents)} and ${money(config.limits.maxCents)}. Enter the exact amount you sent.` }),
    ]),
    el('div', { class: 'grid-2' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'sender_account', text: 'Account you sent from' }),
        el('input', { class: 'input', type: 'text', id: 'sender_account', name: 'sender_account', placeholder: '0300 1234567', autocomplete: 'off' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'sender_name' }, [
          'Name on that account ', el('span', { class: 'optional', text: '(optional)' }),
        ]),
        el('input', { class: 'input', type: 'text', id: 'sender_name', name: 'sender_name', autocomplete: 'off' }),
      ]),
    ]),
    el('div', { class: 'grid-2' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'provider_txn_ref', text: 'Transaction ID' }),
        el('input', { class: 'input', type: 'text', id: 'provider_txn_ref', name: 'provider_txn_ref', autocomplete: 'off' }),
        el('p', { class: 'hint', text: 'The reference on your payment confirmation. This is what we match against our records.' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'paid_at', text: 'When you sent it' }),
        el('input', { class: 'input', type: 'datetime-local', id: 'paid_at', name: 'paid_at' }),
      ]),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'screenshot', text: 'Payment screenshot' }),
      el('input', { class: 'input', type: 'file', id: 'screenshot', name: 'screenshot', accept: 'image/jpeg,image/png' }),
      el('p', { class: 'hint', text: 'JPEG or PNG. This is supporting evidence for our reviewer — on its own it does not prove a payment was received.' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'user_note' }, [
        'Note for our team ', el('span', { class: 'optional', text: '(optional)' }),
      ]),
      el('textarea', { class: 'textarea', id: 'user_note', name: 'user_note', maxlength: '500' }),
    ]),
    el('div', { id: 'deposit-error' }),
    el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', id: 'deposit-submit', text: 'Submit for verification' }),
  ]);

  form.querySelector('#method_id').addEventListener('change', (e) => {
    selected = ready.find((m) => String(m.id) === e.target.value) || ready[0];
    renderAccount();
  });

  // Default the timestamp to now, in the user's own local time.
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  form.querySelector('#paid_at').value = now.toISOString().slice(0, 16);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    clear($('#deposit-error'));

    const submit = $('#deposit-submit');
    const file = form.querySelector('#screenshot').files[0];

    const confirmed = await confirmDialog({
      title: 'Submit this deposit for verification?',
      body: el('div', {}, [
        el('p', { class: 'muted', text: 'Check the amount and the transaction ID match your payment confirmation exactly. A mismatch slows the review down.' }),
        el('dl', { class: 'deflist', style: 'margin-top:var(--s-4)' }, [
          el('div', { class: 'defrow' }, [el('dt', { text: 'Amount' }), el('dd', { text: `$${form.querySelector('#amount').value || '—'}` })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Method' }), el('dd', { text: selected.name })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Transaction ID' }), el('dd', { text: form.querySelector('#provider_txn_ref').value || '—' })]),
        ]),
        el('div', { class: 'notice notice-info', style: 'margin-top:var(--s-4)' }, [
          el('div', { text: 'Submitting records a claim. Your balance changes only once our team verifies the payment.' }),
        ]),
      ]),
      confirmLabel: 'Submit',
    });
    if (!confirmed) return;

    const body = new FormData();
    body.append('amount', form.querySelector('#amount').value);
    body.append('method_id', form.querySelector('#method_id').value);
    body.append('sender_account', form.querySelector('#sender_account').value);
    body.append('sender_name', form.querySelector('#sender_name').value);
    body.append('provider_txn_ref', form.querySelector('#provider_txn_ref').value);
    body.append('paid_at', form.querySelector('#paid_at').value);
    body.append('user_note', form.querySelector('#user_note').value);
    if (file) body.append('screenshot', file);

    const restore = busy(submit, 'Submitting…');
    try {
      const result = await api.postForm('/api/deposits', body);
      toast(`Deposit ${result.deposit.ref} submitted for verification.`, 'pos');
      go(`/deposits/${result.deposit.ref}`);
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(form, error.fields)) return;
      clear($('#deposit-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  root.append(el('div', { class: 'split' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Your deposit details' })]),
      el('div', { class: 'card-body' }, [form]),
    ]),
    el('div', { class: 'stack-4' }, [
      accountPanel,
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'How verification works' })]),
        el('div', { class: 'card-body' }, [
          el('p', { class: 'muted', style: 'font-size:var(--t-base)', text: config.instructions }),
          el('div', { class: 'notice notice-warn', style: 'margin-top:var(--s-4)' }, [
            el('div', {}, [
              el('strong', { text: 'A screenshot is not proof of payment' }),
              el('span', { text: 'Our team matches the transaction ID, the amount and the sending account against our actual receiving account records before anything is credited.' }),
            ]),
          ]),
          el('p', { class: 'hint', style: 'margin-top:var(--s-4)', text: `Reviews are normally completed within ${config.reviewSlaHours} hours.` }),
        ]),
      ]),
    ]),
  ]));

  return root;
}

export async function renderDeposits() {
  const data = await api.get('/api/deposits?limit=50');
  const root = el('div', { class: 'stack-6' });
  root.append(pageHead(
    'Deposit history',
    'Every submission you have made and where it got to.',
    el('a', { class: 'btn btn-primary', href: '#/deposit' }, [icon('plus', 16), el('span', { text: 'New deposit' })]),
  ));

  if (!data.items.length) {
    root.append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({
      title: 'No deposits yet',
      body: 'When you fund your account, each submission appears here with its status and full history.',
      action: el('a', { class: 'btn btn-primary', href: '#/deposit', text: 'Make your first deposit' }),
    })])]));
    return root;
  }

  const body = el('tbody');
  for (const d of data.items) {
    body.append(el('tr', {
      class: 'clickable', onclick: () => go(`/deposits/${d.ref}`),
    }, [
      el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: d.ref })]),
      el('td', { class: 'num primary', dataset: { label: 'Amount' }, text: money(d.amountCents) }),
      el('td', { dataset: { label: 'Method' }, text: d.method || '—' }),
      el('td', { dataset: { label: 'Submitted' }, class: 'muted', text: dateOnly(d.createdAt) }),
      el('td', { dataset: { label: 'Status' } }, [badgeFor(d.status)]),
    ]));
  }

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Reference' }), el('th', { class: 'num', text: 'Amount' }),
          el('th', { text: 'Method' }), el('th', { text: 'Submitted' }), el('th', { text: 'Status' }),
        ])]),
        body,
      ]),
    ]),
  ]));
  return root;
}

export async function renderDepositDetail([ref]) {
  const data = await api.get(`/api/deposits/${encodeURIComponent(ref)}`);
  const d = data.deposit;
  const root = el('div', { class: 'stack-6' });

  root.append(backLink('#/deposits', 'All deposits'));
  root.append(el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [
        el('h2', { text: money(d.amountCents) }),
        el('p', {}, [el('span', { class: 'ref', text: d.ref }), ` · submitted ${dateTime(d.createdAt)}`]),
      ]),
      badgeFor(d.status),
    ]),
  ]));

  const statusCopy = {
    pending: ['info', 'In the queue', 'Our team has not looked at this yet. Nothing has been credited.'],
    under_review: ['info', 'Being reviewed', 'Our team is matching this against our receiving account records.'],
    info_requested: ['warn', 'More information needed', d.reviewNote || 'Our team needs more detail before this can be verified.'],
    verified: ['pos', 'Verified and credited', 'This payment was matched against our receiving account records and credited to your available balance.'],
    rejected: ['neg', 'Rejected', d.reviewNote || 'This submission could not be verified. Nothing was credited.'],
    cancelled: ['neutral', 'Cancelled', 'You cancelled this submission. Nothing was credited.'],
  }[d.status];

  root.append(el('div', { class: `notice notice-${statusCopy[0]}` }, [
    el('div', {}, [el('strong', { text: statusCopy[1] }), el('span', { text: statusCopy[2] })]),
  ]));

  const canCancel = ['pending', 'info_requested'].includes(d.status);

  root.append(el('div', { class: 'split' }, [
    el('div', { class: 'stack-4' }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'Submission' })]),
        el('div', { class: 'card-body' }, [
          el('dl', { class: 'deflist' }, [
            el('div', { class: 'defrow' }, [el('dt', { text: 'Amount' }), el('dd', { text: money(d.amountCents) })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Method' }), el('dd', { text: d.method || '—' })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Transaction ID' }), el('dd', { class: 'mono', text: d.providerTxnRef })]),
            el('div', { class: 'defrow' }, [el('dt', { text: 'Sent from' }), el('dd', { text: d.senderAccount })]),
            d.senderName ? el('div', { class: 'defrow' }, [el('dt', { text: 'Sender name' }), el('dd', { text: d.senderName })]) : null,
            el('div', { class: 'defrow' }, [el('dt', { text: 'Paid at' }), el('dd', { text: dateTime(d.paidAt) })]),
            d.userNote ? el('div', { class: 'defrow' }, [el('dt', { text: 'Your note' }), el('dd', { text: d.userNote })]) : null,
          ]),
          canCancel
            ? el('button', {
              class: 'btn btn-secondary', type: 'button', style: 'margin-top:var(--s-5)',
              text: 'Cancel this submission',
              onclick: async (event) => {
                const ok = await confirmDialog({
                  title: 'Cancel this deposit submission?',
                  body: 'This withdraws your claim from the review queue. If you actually sent the money, do not cancel — contact support instead.',
                  confirmLabel: 'Cancel submission', tone: 'danger',
                });
                if (!ok) return;
                const restore = busy(event.target, 'Cancelling…');
                try {
                  await api.post(`/api/deposits/${encodeURIComponent(ref)}/cancel`, {});
                  toast('Submission cancelled.', 'warn');
                  go('/deposits');
                } catch (error) { restore(); toast(error.message, 'neg'); }
              },
            })
            : null,
        ]),
      ]),
      data.evidence.length ? el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'Evidence you attached' })]),
        el('div', { class: 'card-body' }, data.evidence.map((f) => el('div', { class: 'evidence-frame' }, [
          el('img', { src: f.url, alt: 'Payment screenshot you uploaded', loading: 'lazy' }),
          el('div', { class: 'evidence-caption', text: `${f.name} · ${(f.sizeBytes / 1024).toFixed(0)} KB · uploaded ${dateTime(f.uploadedAt)}` }),
        ]))),
      ]) : null,
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'History' })]),
      el('div', { class: 'card-body' }, [timeline(data.history)]),
    ]),
  ]));

  return root;
}

/* ===========================================================================
   Withdrawals
   =========================================================================== */
export async function renderWithdrawForm() {
  const options = await api.get('/api/withdrawals/options');
  const root = el('div', { class: 'stack-6' });

  root.append(pageHead(
    'Withdraw funds',
    'Request a payout from your available balance. The amount is held as soon as you submit, and returned if the request is rejected or cancelled.',
  ));

  if (!options.enabled) {
    root.append(el('div', { class: 'notice notice-warn' }, [
      el('div', {}, [el('strong', { text: 'Withdrawals are paused' }),
        el('span', { text: 'New requests are not being accepted at the moment. Contact support if you need help.' })]),
    ]));
    return root;
  }

  const feeRate = options.feeBps / 10000;
  const summary = el('dl', { class: 'deflist' });

  const form = el('form', { novalidate: true, id: 'withdraw-form' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'amount', text: 'Amount to withdraw' }),
      el('div', { class: 'input-money' }, [
        el('input', { class: 'input', type: 'text', inputmode: 'decimal', id: 'amount', name: 'amount', placeholder: '0.00', autocomplete: 'off' }),
      ]),
      el('p', { class: 'hint' }, [
        `Available: ${money(options.availableCents)}. Minimum ${money(options.minCents)}. `,
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-sm', style: 'padding:0 4px;min-height:auto',
          text: 'Withdraw all',
          onclick: () => {
            form.querySelector('#amount').value = (options.availableCents / 100).toFixed(2);
            form.querySelector('#amount').dispatchEvent(new Event('input'));
          },
        }),
      ]),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'method_id', text: 'Payout method' }),
      el('select', { class: 'select', id: 'method_id', name: 'method_id' },
        options.methods.map((m) => el('option', { value: String(m.id), text: m.name }))),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'payout_title', text: 'Account title' }),
      el('input', { class: 'input', type: 'text', id: 'payout_title', name: 'payout_title', autocomplete: 'name' }),
      el('p', { class: 'hint', text: 'Payouts are sent to an account in your own name.' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'payout_account', text: 'Account number' }),
      el('input', { class: 'input', type: 'text', id: 'payout_account', name: 'payout_account', autocomplete: 'off' }),
    ]),
    el('div', { id: 'withdraw-error' }),
    el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', id: 'withdraw-submit', text: 'Submit withdrawal request' }),
  ]);

  function parse(value) {
    const cleaned = String(value || '').replace(/[,\s$]/g, '');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
    const [w, f = ''] = cleaned.split('.');
    return Number(w) * 100 + Number((f + '00').slice(0, 2));
  }

  function renderSummary() {
    const cents = parse(form.querySelector('#amount').value) || 0;
    const fee = Math.floor(cents * feeRate);
    clear(summary).append(
      el('div', { class: 'defrow' }, [el('dt', { text: 'You requested' }), el('dd', { text: money(cents) })]),
      el('div', { class: 'defrow' }, [el('dt', { text: 'Fee' }), el('dd', { text: fee ? `− ${money(fee)}` : 'None' })]),
      el('div', { class: 'defrow' }, [el('dt', { text: 'You receive' }), el('dd', { text: money(cents - fee) })]),
      el('div', { class: 'defrow' }, [el('dt', { text: 'Balance after hold' }), el('dd', { text: money(Math.max(0, options.availableCents - cents)) })]),
    );
  }
  form.querySelector('#amount').addEventListener('input', renderSummary);
  renderSummary();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    clear($('#withdraw-error'));
    const cents = parse(form.querySelector('#amount').value) || 0;

    const ok = await confirmDialog({
      title: 'Submit this withdrawal request?',
      body: el('div', {}, [
        el('p', { class: 'muted', text: 'Check the payout account carefully. Payments sent to an incorrect account number cannot always be recovered.' }),
        el('dl', { class: 'deflist', style: 'margin-top:var(--s-4)' }, [
          el('div', { class: 'defrow' }, [el('dt', { text: 'Amount' }), el('dd', { text: money(cents) })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'To account' }), el('dd', { text: form.querySelector('#payout_account').value || '—' })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Account title' }), el('dd', { text: form.querySelector('#payout_title').value || '—' })]),
        ]),
        el('div', { class: 'notice notice-info', style: 'margin-top:var(--s-4)' }, [
          el('div', { text: `${money(cents)} will be held from your available balance immediately and returned if this request is rejected or cancelled.` }),
        ]),
      ]),
      confirmLabel: 'Submit request',
    });
    if (!ok) return;

    const submit = $('#withdraw-submit');
    const restore = busy(submit, 'Submitting…');
    try {
      const result = await api.post('/api/withdrawals', {
        amount: form.querySelector('#amount').value,
        method_id: Number(form.querySelector('#method_id').value),
        payout_title: form.querySelector('#payout_title').value,
        payout_account: form.querySelector('#payout_account').value,
      });
      toast(`Withdrawal ${result.withdrawal.ref} submitted.`, 'pos');
      go(`/withdrawals/${result.withdrawal.ref}`);
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(form, error.fields)) return;
      clear($('#withdraw-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  const side = el('div', { class: 'stack-4' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Summary' })]),
      el('div', { class: 'card-body' }, [summary]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Withdrawal rules' })]),
      el('div', { class: 'card-body' }, [
        el('p', { class: 'muted', style: 'font-size:var(--t-base)', text: options.rules }),
      ]),
    ]),
  ]);

  // WhatsApp is offered as an alternative channel, with the details prefilled
  // so support receives an unambiguous request rather than a bare "withdraw".
  if (options.whatsapp?.digits) {
    side.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Prefer WhatsApp?' })]),
      el('div', { class: 'card-body' }, [
        el('p', { class: 'muted', style: 'font-size:var(--t-base)', text: `You can also send your request to ${options.whatsapp.display}. Our team will confirm it against your account before anything is paid.` }),
        el('a', {
          class: 'btn btn-whatsapp btn-block', style: 'margin-top:var(--s-4)', target: '_blank', rel: 'noopener',
          href: `https://wa.me/${options.whatsapp.digits}?text=${encodeURIComponent(
            `Withdrawal request\nAccount ID: ${store.user.publicId}\nName: ${store.user.fullName}\nAmount: `
          )}`,
          text: 'Request on WhatsApp',
        }),
      ]),
    ]));
  }

  root.append(el('div', { class: 'split' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Request details' })]),
      el('div', { class: 'card-body' }, [form]),
    ]),
    side,
  ]));
  return root;
}

export async function renderWithdrawals() {
  const data = await api.get('/api/withdrawals?limit=50');
  const root = el('div', { class: 'stack-6' });
  root.append(pageHead(
    'Withdrawal history',
    'Every request and exactly where it is in the process.',
    el('a', { class: 'btn btn-primary', href: '#/withdraw' }, [icon('plus', 16), el('span', { text: 'New request' })]),
  ));

  if (!data.items.length) {
    root.append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({
      title: 'No withdrawal requests yet',
      body: 'When you request a payout it appears here, along with the hold placed on your balance and every status change.',
    })])]));
    return root;
  }

  const body = el('tbody');
  for (const w of data.items) {
    body.append(el('tr', { class: 'clickable', onclick: () => go(`/withdrawals/${w.ref}`) }, [
      el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: w.ref })]),
      el('td', { class: 'num primary', dataset: { label: 'Amount' }, text: money(w.amountCents) }),
      el('td', { class: 'num', dataset: { label: 'You receive' }, text: money(w.netCents) }),
      el('td', { dataset: { label: 'To' }, class: 'mono muted', text: w.payoutAccountMasked }),
      el('td', { dataset: { label: 'Requested' }, class: 'muted', text: dateOnly(w.createdAt) }),
      el('td', { dataset: { label: 'Status' } }, [badgeFor(w.status)]),
    ]));
  }

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Reference' }), el('th', { class: 'num', text: 'Amount' }),
          el('th', { class: 'num', text: 'You receive' }), el('th', { text: 'To' }),
          el('th', { text: 'Requested' }), el('th', { text: 'Status' }),
        ])]),
        body,
      ]),
    ]),
  ]));
  return root;
}

const WITHDRAWAL_STAGES = ['pending', 'under_review', 'approved', 'processing', 'completed'];

export async function renderWithdrawalDetail([ref]) {
  const data = await api.get(`/api/withdrawals/${encodeURIComponent(ref)}`);
  const w = data.withdrawal;
  const root = el('div', { class: 'stack-6' });

  root.append(backLink('#/withdrawals', 'All withdrawals'));
  root.append(el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [
        el('h2', { text: money(w.amountCents) }),
        el('p', {}, [el('span', { class: 'ref', text: w.ref }), ` · requested ${dateTime(w.createdAt)}`]),
      ]),
      badgeFor(w.status),
    ]),
  ]));

  if (['rejected', 'cancelled'].includes(w.status)) {
    root.append(el('div', { class: 'notice notice-warn' }, [
      el('div', {}, [
        el('strong', { text: w.status === 'rejected' ? 'Request rejected' : 'Request cancelled' }),
        el('span', { text: `${w.reviewNote ? `${w.reviewNote} ` : ''}${money(w.amountCents)} has been returned to your available balance.` }),
      ]),
    ]));
  } else if (w.status === 'completed') {
    root.append(el('div', { class: 'notice notice-pos' }, [
      el('div', {}, [
        el('strong', { text: 'Paid out' }),
        el('span', { text: `${money(w.netCents)} was sent to your nominated account${w.providerRef ? `, provider reference ${w.providerRef}` : ''}.` }),
      ]),
    ]));
  } else {
    root.append(el('div', { class: 'notice notice-info' }, [
      el('div', {}, [
        el('strong', { text: 'On hold while we review' }),
        el('span', { text: `${money(w.amountCents)} is held from your available balance. It is returned automatically if this request is rejected or cancelled.` }),
      ]),
    ]));
  }

  // Progress rail
  const currentIndex = WITHDRAWAL_STAGES.indexOf(w.status);
  const rail = el('div', { class: 'row', style: 'gap:var(--s-2);flex-wrap:wrap' },
    WITHDRAWAL_STAGES.map((stage, i) => el('span', {
      class: `badge badge-${i <= currentIndex && currentIndex >= 0 ? (i === currentIndex ? statusTone(stage) : 'pos') : 'neutral'}`,
      text: statusLabel(stage),
      style: i > currentIndex || currentIndex < 0 ? 'opacity:0.45' : null,
    })));

  root.append(el('div', { class: 'split' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Request' })]),
      el('div', { class: 'card-body' }, [
        ['rejected', 'cancelled'].includes(w.status) ? null : rail,
        el('dl', { class: 'deflist', style: 'margin-top:var(--s-5)' }, [
          el('div', { class: 'defrow' }, [el('dt', { text: 'Amount requested' }), el('dd', { text: money(w.amountCents) })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Fee' }), el('dd', { text: w.feeCents ? `− ${money(w.feeCents)}` : 'None' })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'You receive' }), el('dd', { text: money(w.netCents) })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Method' }), el('dd', { text: w.method || '—' })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Account title' }), el('dd', { text: w.payoutTitle })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Account number' }), el('dd', { class: 'mono', text: w.payoutAccountMasked })]),
        ]),
        w.cancellable
          ? el('button', {
            class: 'btn btn-secondary', type: 'button', style: 'margin-top:var(--s-5)',
            text: 'Cancel this request',
            onclick: async (event) => {
              const ok = await confirmDialog({
                title: 'Cancel this withdrawal request?',
                body: `${money(w.amountCents)} will be returned to your available balance immediately.`,
                confirmLabel: 'Cancel request', tone: 'danger',
              });
              if (!ok) return;
              const restore = busy(event.target, 'Cancelling…');
              try {
                await api.post(`/api/withdrawals/${encodeURIComponent(ref)}/cancel`, {});
                toast('Request cancelled and the hold released.', 'warn');
                go('/withdrawals');
              } catch (error) { restore(); toast(error.message, 'neg'); }
            },
          })
          : null,
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'History' })]),
      el('div', { class: 'card-body' }, [timeline(data.history)]),
    ]),
  ]));

  return root;
}

/* ===========================================================================
   Investments
   =========================================================================== */
export async function renderInvestments() {
  const [data, me] = await Promise.all([
    api.get('/api/investments?limit=50'),
    api.get('/api/me'),
  ]);
  const root = el('div', { class: 'stack-6' });
  root.append(pageHead(
    'Investments',
    'Commit part of your available balance. The example figures in force are recorded against each investment, so a later settings change never rewrites what you were shown.',
  ));

  const form = el('form', { novalidate: true, id: 'invest-form' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'amount', text: 'Amount to commit' }),
      el('div', { class: 'input-money' }, [
        el('input', { class: 'input', type: 'text', inputmode: 'decimal', id: 'amount', name: 'amount', placeholder: '0.00', autocomplete: 'off' }),
      ]),
      el('p', { class: 'hint', text: `Between ${money(data.limits.minCents)} and ${money(data.limits.maxCents)}. Available balance: ${money(me.balances.availableCents)}.` }),
    ]),
    el('div', { class: 'notice notice-warn' }, [el('div', { id: 'invest-illus', text: 'Enter an amount to see the example figures.' })]),
    el('div', { class: 'checkline', style: 'margin-top:var(--s-4)' }, [
      el('input', { type: 'checkbox', id: 'acknowledge_risk', name: 'acknowledge_risk' }),
      el('label', { for: 'acknowledge_risk', text: 'I understand that forex trading involves substantial risk, that the figures above are an example of the platform’s calculation model and not a guaranteed return, and that I may lose some or all of this amount.' }),
    ]),
    el('div', { id: 'invest-error' }),
    el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', id: 'invest-submit', text: 'Commit this amount' }),
  ]);

  function parse(value) {
    const cleaned = String(value || '').replace(/[,\s$]/g, '');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
    const [w, f = ''] = cleaned.split('.');
    return Number(w) * 100 + Number((f + '00').slice(0, 2));
  }

  form.querySelector('#amount').addEventListener('input', () => {
    const cents = parse(form.querySelector('#amount').value);
    const out = form.querySelector('#invest-illus');
    if (!cents) { out.textContent = 'Enter an amount to see the example figures.'; return; }
    const daily = Math.round(cents / data.model.divisor);
    const cycle = Math.round((cents * data.model.cycleDays) / data.model.divisor);
    out.textContent = `Illustrative only: ${money(daily)} per day and ${money(cycle)} across ${data.model.cycleDays} market days, under the platform's example model (amount ÷ ${data.model.divisor}). ${data.disclaimer}`;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    clear($('#invest-error'));
    const cents = parse(form.querySelector('#amount').value) || 0;

    const ok = await confirmDialog({
      title: 'Commit this amount?',
      body: el('div', {}, [
        el('p', { class: 'muted', text: `${money(cents)} moves from your available balance into committed principal. Your total balance does not change — the money is reclassified, not spent.` }),
        el('div', { class: 'notice notice-warn', style: 'margin-top:var(--s-4)' }, [
          el('div', { text: 'Forex trading can produce a loss. You may receive back less than you commit.' }),
        ]),
      ]),
      confirmLabel: 'Commit',
    });
    if (!ok) return;

    const restore = busy($('#invest-submit'), 'Committing…');
    try {
      const result = await api.post('/api/investments', {
        amount: form.querySelector('#amount').value,
        acknowledge_risk: form.querySelector('#acknowledge_risk').checked,
      });
      toast(`Investment ${result.investment.ref} opened.`, 'pos');
      go('/investments');
      // The route re-renders from the hash change; force it when already here.
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(form, error.fields)) return;
      clear($('#invest-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  const listCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [el('h3', { text: 'Your investments' })]),
  ]);

  if (!data.items.length) {
    listCard.append(el('div', { class: 'card-body' }, [emptyState({
      title: 'No investments yet',
      body: 'Commit an amount from your available balance to open one.',
    })]));
  } else {
    const body = el('tbody');
    for (const i of data.items) {
      body.append(el('tr', {}, [
        el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: i.ref })]),
        el('td', { class: 'num primary', dataset: { label: 'Principal' }, text: money(i.principalCents) }),
        el('td', { class: 'num muted', dataset: { label: 'Example daily' }, text: money(i.illustrative.dailyCents) }),
        el('td', { class: 'num muted', dataset: { label: `Example cycle` }, text: money(i.illustrative.cycleCents) }),
        el('td', { dataset: { label: 'Opened' }, class: 'muted', text: dateOnly(i.openedAt) }),
        el('td', { dataset: { label: 'Status' } }, [badgeFor(i.status)]),
      ]));
    }
    listCard.append(
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data stackable' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Reference' }), el('th', { class: 'num', text: 'Principal' }),
            el('th', { class: 'num', text: 'Example daily' }), el('th', { class: 'num', text: 'Example cycle' }),
            el('th', { text: 'Opened' }), el('th', { text: 'Status' }),
          ])]),
          body,
        ]),
      ]),
      el('div', { class: 'card-footer', text: 'The example columns are illustrative figures from the platform’s calculation model recorded when each investment opened. They are not amounts owed to you and are never added to your balance.' }),
    );
  }

  root.append(el('div', { class: 'split' }, [
    listCard,
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Open an investment' })]),
      el('div', { class: 'card-body' }, [form]),
    ]),
  ]));
  return root;
}

/* ===========================================================================
   Transactions
   =========================================================================== */
export async function renderTransactions() {
  const root = el('div', { class: 'stack-6' });
  root.append(pageHead('Transactions', 'Every credit and debit on your account, each with a permanent reference.'));

  const tableCard = el('div', { class: 'card' });
  const filters = el('div', { class: 'filters' });
  root.append(filters, tableCard);

  let currentType = '';

  async function load() {
    clear(tableCard).append(el('div', { class: 'card-body' }, [
      el('div', { class: 'skeleton skeleton-line', style: 'width:100%' }),
      el('div', { class: 'skeleton skeleton-line', style: 'width:85%' }),
      el('div', { class: 'skeleton skeleton-line', style: 'width:70%' }),
    ]));

    const query = currentType ? `?limit=100&type=${encodeURIComponent(currentType)}` : '?limit=100';
    const data = await api.get(`/api/transactions${query}`);

    if (!filters.childElementCount) {
      filters.append(
        el('label', { class: 'visually-hidden', for: 'txn-type', text: 'Filter by type' }),
        el('select', {
          class: 'select', id: 'txn-type', style: 'max-width:260px',
          onchange: (e) => { currentType = e.target.value; load(); },
        }, [
          el('option', { value: '', text: 'All transaction types' }),
          ...data.types.map((t) => el('option', { value: t.key, text: t.label })),
        ]),
      );
    }

    if (!data.items.length) {
      clear(tableCard).append(el('div', { class: 'card-body' }, [emptyState({
        title: currentType ? 'No transactions of that type' : 'No transactions yet',
        body: currentType
          ? 'Try a different filter.'
          : 'Your ledger fills in as deposits are verified and money moves through your account.',
      })]));
      return;
    }

    const body = el('tbody');
    for (const t of data.items) {
      body.append(el('tr', {}, [
        el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: t.ref })]),
        el('td', { class: 'primary', dataset: { label: 'Type' }, text: t.label }),
        el('td', { dataset: { label: 'Bucket' }, class: 'muted', text: t.bucket === 'invested' ? 'Invested' : 'Available' }),
        el('td', {
          class: 'num', dataset: { label: 'Amount' },
          style: `color:var(--${t.direction === 'credit' ? 'pos-700' : 'ink-900'});font-weight:560`,
          text: `${t.direction === 'credit' ? '+' : '−'}${money(t.amountCents)}`,
        }),
        el('td', { dataset: { label: 'Date' }, class: 'muted', text: dateTime(t.createdAt) }),
        el('td', { dataset: { label: 'Status' } }, [
          t.status === 'reversed'
            ? el('span', { class: 'badge badge-neutral', text: 'Reversed' })
            : el('span', { class: 'badge badge-pos', text: 'Posted' }),
        ]),
      ]));
    }

    clear(tableCard).append(
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data stackable' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Reference' }), el('th', { text: 'Type' }), el('th', { text: 'Bucket' }),
            el('th', { class: 'num', text: 'Amount' }), el('th', { text: 'Date' }), el('th', { text: 'Status' }),
          ])]),
          body,
        ]),
      ]),
      el('div', { class: 'card-footer', text: 'A reversed entry stays on your ledger and is cancelled by the mirroring entry beside it. History is never deleted or rewritten.' }),
    );
  }

  await load();
  return root;
}
