/*
 * Phone verification, identity verification, security, activity and support.
 */
import { api, ApiError } from '/assets/js/api.js';
import {
  el, clear, $, $$, toast, emptyState, applyFieldErrors, clearFieldErrors, busy, confirmDialog,
} from '/assets/js/ui.js';
import { money, dateTime, dateOnly, relative, statusTone, statusLabel } from '/assets/js/format.js';
import { icon } from './icons.js';
import { store, go } from './app.js';

function pageHead(title, description) {
  return el('div', { class: 'page-head' }, [el('h2', { text: title }), el('p', { text: description })]);
}

/* ===========================================================================
   Phone verification
   =========================================================================== */
export async function renderVerify() {
  const session = await api.get('/api/auth/session');
  store.user = session.user;

  const root = el('div', { class: 'form-narrow', style: 'margin:0 auto' });
  root.append(el('div', { class: 'page-head', style: 'text-align:center' }, [
    el('h2', { text: 'Verify your mobile number' }),
    el('p', { style: 'margin:0 auto', text: `We sent a code to ${session.user.phoneMasked}. Enter it below to activate your account.` }),
  ]));

  const inputs = Array.from({ length: 4 }, (_, i) => el('input', {
    type: 'text', inputmode: 'numeric', maxlength: '1', autocomplete: i === 0 ? 'one-time-code' : 'off',
    'aria-label': `Digit ${i + 1}`,
  }));

  const row = el('div', { class: 'otp-row' }, inputs);
  const errorBox = el('div', { id: 'otp-error' });
  const submit = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', text: 'Verify and continue' });

  inputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      input.classList.toggle('filled', Boolean(input.value));
      if (input.value && index < inputs.length - 1) inputs[index + 1].focus();
      if (inputs.every((i) => i.value)) submit.focus();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && index > 0) inputs[index - 1].focus();
    });
    input.addEventListener('paste', (e) => {
      const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '');
      if (!text) return;
      e.preventDefault();
      inputs.forEach((target, i) => {
        target.value = text[i] || '';
        target.classList.toggle('filled', Boolean(target.value));
      });
      (inputs.find((i) => !i.value) || submit).focus();
    });
  });

  const form = el('form', { novalidate: true }, [row, errorBox, submit]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(errorBox);
    const code = inputs.map((i) => i.value).join('');
    if (code.length < inputs.length) {
      clear(errorBox).append(el('p', { class: 'error-text', text: 'Enter all four digits.' }));
      return;
    }
    const restore = busy(submit, 'Verifying…');
    try {
      await api.post('/api/auth/verify/confirm', { code });
      toast('Your mobile number is verified.', 'pos');
      sessionStorage.removeItem('fxp_dev_otp');
      window.location.reload();
    } catch (error) {
      restore();
      inputs.forEach((i) => { i.value = ''; i.classList.remove('filled'); });
      inputs[0].focus();
      clear(errorBox).append(el('p', { class: 'error-text', text: error.message }));
    }
  });

  const resend = el('button', { class: 'btn btn-ghost btn-block', type: 'button', text: 'Send a new code' });
  let cooldown = 0;
  const tick = () => {
    if (cooldown <= 0) { resend.disabled = false; resend.textContent = 'Send a new code'; return; }
    resend.disabled = true;
    resend.textContent = `Send a new code in ${cooldown}s`;
    cooldown -= 1;
    setTimeout(tick, 1000);
  };
  resend.addEventListener('click', async () => {
    try {
      const result = await api.post('/api/auth/verify/request', {});
      if (result.developmentCode) sessionStorage.setItem('fxp_dev_otp', result.developmentCode);
      toast('A new code is on its way.', 'pos');
      cooldown = 60; tick();
      renderDevHint();
    } catch (error) {
      toast(error.message, 'warn');
      if (error.status === 429) { cooldown = 60; tick(); }
    }
  });

  const devHint = el('div', {});
  function renderDevHint() {
    const code = sessionStorage.getItem('fxp_dev_otp');
    clear(devHint);
    if (!code) return;
    // Only ever present when the server has no SMS provider configured, which
    // it refuses to be in production.
    devHint.append(el('div', { class: 'notice notice-warn', style: 'margin-top:var(--s-4)' }, [
      el('div', {}, [
        el('strong', { text: 'Development mode' }),
        el('span', { text: `No SMS provider is configured on this server, so no message was sent. The code for this session is ${code}.` }),
      ]),
    ]));
  }
  renderDevHint();

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-body' }, [
      form,
      el('hr', { class: 'divider' }),
      resend,
      devHint,
      el('p', { class: 'hint', style: 'text-align:center;margin-top:var(--s-4)', text: 'The code expires in a few minutes and can only be tried a limited number of times. Never share it with anyone, including our staff.' }),
    ]),
  ]));

  root.append(el('p', { class: 'auth-alt', style: 'margin-top:var(--s-6)' }, [
    'Wrong number? ',
    el('a', { href: '#/support', text: 'Contact support' }),
    ' · ',
    el('a', {
      href: '#', text: 'Sign out',
      onclick: async (e) => {
        e.preventDefault();
        try { await api.post('/api/auth/logout', {}); } catch { /* sign out locally regardless */ }
        window.location.href = '/';
      },
    }),
  ]));

  return root;
}

/* ===========================================================================
   Identity verification
   =========================================================================== */
export async function renderVerification() {
  const [me, kyc] = await Promise.all([api.get('/api/me'), api.get('/api/kyc')]);
  const root = el('div', { class: 'stack-6' });
  root.append(pageHead('Verification', 'What we have confirmed about your account, and what is outstanding.'));

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [el('h3', { text: 'Status' })]),
    el('div', { class: 'card-body' }, [
      el('dl', { class: 'deflist' }, [
        el('div', { class: 'defrow' }, [
          el('dt', { text: 'Mobile number' }),
          el('dd', {}, [me.verification.phone.done
            ? el('span', { class: 'badge badge-pos', text: 'Verified' })
            : el('span', { class: 'badge badge-warn', text: 'Not verified' })]),
        ]),
        el('div', { class: 'defrow' }, [
          el('dt', { text: 'Account status' }),
          el('dd', {}, [el('span', { class: `badge badge-${statusTone(me.user.status)}`, text: me.user.statusLabel })]),
        ]),
        el('div', { class: 'defrow' }, [
          el('dt', { text: 'Identity document' }),
          el('dd', {}, [kyc.record
            ? el('span', { class: `badge badge-${statusTone(kyc.record.status)}`, text: statusLabel(kyc.record.status) })
            : el('span', { class: `badge badge-${kyc.required ? 'warn' : 'neutral'}`, text: kyc.required ? 'Required' : 'Not submitted' })]),
        ]),
      ]),
    ]),
  ]));

  if (kyc.record) {
    root.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Your identity document' })]),
      el('div', { class: 'card-body' }, [
        el('dl', { class: 'deflist' }, [
          el('div', { class: 'defrow' }, [el('dt', { text: 'Document number' }), el('dd', { class: 'mono', text: kyc.record.masked })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Submitted' }), el('dd', { text: dateTime(kyc.record.submittedAt) })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Consent given' }), el('dd', { text: dateTime(kyc.record.consentAt) })]),
          el('div', { class: 'defrow' }, [el('dt', { text: 'Due for deletion' }), el('dd', { text: dateOnly(kyc.record.retentionUntil) })]),
          kyc.record.note ? el('div', { class: 'defrow' }, [el('dt', { text: 'Reviewer note' }), el('dd', { text: kyc.record.note })]) : null,
        ]),
        el('div', { class: 'notice notice-neutral', style: 'margin-top:var(--s-5)' }, [
          el('div', { text: 'Your document number is encrypted at rest and shown masked everywhere. A member of staff can reveal the full number only with a specific permission, and every reveal is written to an audit log.' }),
        ]),
      ]),
    ]));
    return root;
  }

  const form = el('form', { novalidate: true, id: 'kyc-form' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'cnic', text: 'CNIC number' }),
      el('input', { class: 'input', type: 'text', id: 'cnic', name: 'cnic', inputmode: 'numeric', placeholder: '42101-1234567-3', autocomplete: 'off' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'full_name_on_id', text: 'Name exactly as printed on the document' }),
      el('input', { class: 'input', type: 'text', id: 'full_name_on_id', name: 'full_name_on_id', autocomplete: 'name' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'front' }, ['Photo of the front ', el('span', { class: 'optional', text: '(optional)' })]),
      el('input', { class: 'input', type: 'file', id: 'front', name: 'front', accept: 'image/jpeg,image/png' }),
      el('p', { class: 'hint', text: 'JPEG or PNG. Stored outside the public web root and only readable by staff with the verification permission.' }),
    ]),
    el('div', { class: 'notice notice-neutral' }, [el('div', { text: kyc.purposeNote })]),
    el('div', { class: 'checkline', style: 'margin-top:var(--s-4)' }, [
      el('input', { type: 'checkbox', id: 'consent', name: 'consent' }),
      el('label', { for: 'consent', text: `I consent to this platform storing and processing my identity document for the purposes described above, and I understand it will be retained for up to ${kyc.retentionMonths} months.` }),
    ]),
    el('div', { id: 'kyc-error' }),
    el('button', { class: 'btn btn-primary btn-block', type: 'submit', id: 'kyc-submit', text: 'Submit for review' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    clear($('#kyc-error'));
    const body = new FormData();
    body.append('cnic', form.querySelector('#cnic').value);
    body.append('full_name_on_id', form.querySelector('#full_name_on_id').value);
    body.append('consent', form.querySelector('#consent').checked ? 'true' : 'false');
    const file = form.querySelector('#front').files[0];
    if (file) body.append('front', file);

    const restore = busy($('#kyc-submit'), 'Submitting…');
    try {
      await api.postForm('/api/kyc', body);
      toast('Identity document submitted for review.', 'pos');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(form, error.fields)) return;
      clear($('#kyc-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [
      el('div', {}, [
        el('h3', { text: 'Submit your identity document' }),
        el('div', { class: 'sub', text: kyc.required ? 'Required before you can withdraw' : 'Optional' }),
      ]),
    ]),
    el('div', { class: 'card-body' }, [form]),
  ]));

  return root;
}

/* ===========================================================================
   Security
   =========================================================================== */
export async function renderSecurity() {
  const [me, sessions] = await Promise.all([api.get('/api/me'), api.get('/api/me/sessions')]);
  const root = el('div', { class: 'stack-6' });
  root.append(pageHead('Security', 'Your password and the devices signed in to your account.'));

  const pwForm = el('form', { novalidate: true, id: 'pw-form' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'current_password', text: 'Current password' }),
      el('input', { class: 'input', type: 'password', id: 'current_password', name: 'current_password', autocomplete: 'current-password' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'new_password', text: 'New password' }),
      el('input', { class: 'input', type: 'password', id: 'new_password', name: 'new_password', autocomplete: 'new-password' }),
      el('p', { class: 'hint', text: 'At least 10 characters, with upper and lower case letters and a number.' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'confirm_password', text: 'Confirm new password' }),
      el('input', { class: 'input', type: 'password', id: 'confirm_password', name: 'confirm_password', autocomplete: 'new-password' }),
    ]),
    el('div', { id: 'pw-error' }),
    el('button', { class: 'btn btn-primary', type: 'submit', id: 'pw-submit', text: 'Change password' }),
  ]);

  pwForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(pwForm);
    clear($('#pw-error'));
    const restore = busy($('#pw-submit'), 'Changing…');
    try {
      await api.post('/api/me/password', {
        current_password: pwForm.querySelector('#current_password').value,
        new_password: pwForm.querySelector('#new_password').value,
        confirm_password: pwForm.querySelector('#confirm_password').value,
      });
      restore();
      pwForm.reset();
      toast('Password changed. All other sessions were signed out.', 'pos');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(pwForm, error.fields)) return;
      clear($('#pw-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  const sessionRows = el('tbody');
  for (const s of sessions.sessions.filter((x) => x.active)) {
    sessionRows.append(el('tr', {}, [
      el('td', { dataset: { label: 'Device' }, class: 'primary' }, [
        el('div', { text: (s.device || 'Unknown device').slice(0, 60) }),
        s.current ? el('span', { class: 'badge badge-pos', style: 'margin-top:4px', text: 'This device' }) : null,
      ]),
      el('td', { dataset: { label: 'IP' }, class: 'mono muted', text: s.ip || '—' }),
      el('td', { dataset: { label: 'Last active' }, class: 'muted', text: relative(s.lastSeenAt) }),
      el('td', { dataset: { label: '' } }, [
        s.current ? el('span', { class: 'muted', text: '—' }) : el('button', {
          class: 'btn btn-secondary btn-sm', type: 'button', text: 'Sign out',
          onclick: async (event) => {
            const ok = await confirmDialog({
              title: 'Sign this device out?',
              body: 'That device will need to sign in again with your password.',
              confirmLabel: 'Sign out', tone: 'danger',
            });
            if (!ok) return;
            const restore = busy(event.target, '…');
            try {
              await api.del(`/api/me/sessions/${s.id}`);
              toast('Device signed out.', 'pos');
              window.dispatchEvent(new HashChangeEvent('hashchange'));
            } catch (error) { restore(); toast(error.message, 'neg'); }
          },
        }),
      ]),
    ]));
  }

  root.append(el('div', { class: 'split' }, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Active sessions' })]),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data stackable' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Device' }), el('th', { text: 'IP' }), el('th', { text: 'Last active' }), el('th', { text: '' }),
          ])]),
          sessionRows,
        ]),
      ]),
      el('div', { class: 'card-footer', text: 'Do not recognise a device? Sign it out and change your password immediately.' }),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Change password' })]),
      el('div', { class: 'card-body' }, [pwForm]),
    ]),
  ]));

  return root;
}

/* ===========================================================================
   Account activity
   =========================================================================== */
export async function renderActivity() {
  const data = await api.get('/api/me/activity?limit=50');
  const root = el('div', { class: 'stack-6' });
  root.append(pageHead('Account activity', 'A record of the actions taken on your account, including sign-ins.'));

  if (!data.items.length) {
    root.append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({
      title: 'No activity recorded', body: 'Actions you take on your account are listed here.',
    })])]));
    return root;
  }

  const body = el('tbody');
  for (const item of data.items) {
    body.append(el('tr', {}, [
      el('td', { class: 'primary', dataset: { label: 'Action' }, text: item.label }),
      el('td', { dataset: { label: 'Reference' }, class: 'ref muted', text: item.entity || '—' }),
      el('td', { dataset: { label: 'IP' }, class: 'mono muted', text: item.ip || '—' }),
      el('td', { dataset: { label: 'When' }, class: 'muted', text: dateTime(item.at) }),
    ]));
  }

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Action' }), el('th', { text: 'Reference' }), el('th', { text: 'IP' }), el('th', { text: 'When' }),
        ])]),
        body,
      ]),
    ]),
    el('div', { class: 'card-footer', text: `Showing the most recent ${data.items.length} of ${data.total} recorded events.` }),
  ]));
  return root;
}

/* ===========================================================================
   Support
   =========================================================================== */
const CATEGORIES = [
  ['deposit', 'A deposit'],
  ['withdrawal', 'A withdrawal'],
  ['verification', 'Verification'],
  ['account', 'My account'],
  ['other', 'Something else'],
];

export async function renderSupport() {
  const data = await api.get('/api/support');
  const root = el('div', { class: 'stack-6' });
  root.append(pageHead('Support', 'Message our team here, or reach us on WhatsApp.'));

  const waCard = data.whatsapp?.digits ? el('div', { class: 'card', style: 'background:var(--brand-800);border-color:var(--brand-800)' }, [
    el('div', { class: 'card-body' }, [
      el('h3', { style: 'color:#fff;font-size:var(--t-lg);margin-bottom:var(--s-2)', text: 'WhatsApp support' }),
      el('p', { style: 'color:var(--brand-100);font-size:var(--t-base)', text: `Message ${data.whatsapp.display} and quote your account ID ${store.user.publicId}.` }),
      el('p', { style: 'color:var(--brand-300);font-size:var(--t-sm);margin-top:var(--s-2)',
        text: data.hours ? `Human agents: ${data.hours}. Messages outside these hours are answered when the team is next available.` : 'Answered during our published support hours.' }),
      el('a', {
        class: 'btn btn-whatsapp btn-block', style: 'margin-top:var(--s-5)', target: '_blank', rel: 'noopener',
        href: `https://wa.me/${data.whatsapp.digits}?text=${encodeURIComponent(`Hello, my account ID is ${store.user.publicId}.`)}`,
        text: 'Contact support on WhatsApp',
      }),
    ]),
  ]) : null;

  const form = el('form', { novalidate: true, id: 'support-form' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'category', text: 'What is this about?' }),
      el('select', { class: 'select', id: 'category', name: 'category' },
        CATEGORIES.map(([value, label]) => el('option', { value, text: label }))),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'subject', text: 'Subject' }),
      el('input', { class: 'input', type: 'text', id: 'subject', name: 'subject', maxlength: '140' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'message', text: 'Message' }),
      el('textarea', { class: 'textarea', id: 'message', name: 'message', rows: '5', maxlength: '4000' }),
      el('p', { class: 'hint', text: 'Include the reference of any deposit or withdrawal involved — it makes the answer much faster.' }),
    ]),
    el('div', { id: 'support-error' }),
    el('button', { class: 'btn btn-primary btn-block', type: 'submit', id: 'support-submit', text: 'Send to support' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    clear($('#support-error'));
    const restore = busy($('#support-submit'), 'Sending…');
    try {
      const result = await api.post('/api/support', {
        category: form.querySelector('#category').value,
        subject: form.querySelector('#subject').value,
        message: form.querySelector('#message').value,
      });
      toast(`Support request ${result.ref} opened.`, 'pos');
      go(`/support/${result.ref}`);
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(form, error.fields)) return;
      clear($('#support-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  const listCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-header' }, [el('h3', { text: 'Your requests' })]),
  ]);
  if (!data.items.length) {
    listCard.append(el('div', { class: 'card-body' }, [emptyState({
      title: 'No requests yet', body: 'Anything you send our team appears here with the full conversation.',
    })]));
  } else {
    const body = el('tbody');
    for (const item of data.items) {
      body.append(el('tr', { class: 'clickable', onclick: () => go(`/support/${item.ref}`) }, [
        el('td', { dataset: { label: 'Reference' } }, [el('span', { class: 'ref', text: item.ref })]),
        el('td', { class: 'primary', dataset: { label: 'Subject' }, text: item.subject }),
        el('td', { dataset: { label: 'Updated' }, class: 'muted', text: relative(item.updatedAt) }),
        el('td', { dataset: { label: 'Status' } }, [
          el('span', { class: `badge badge-${statusTone(item.status)}`, text: statusLabel(item.status) }),
        ]),
      ]));
    }
    listCard.append(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data stackable' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Reference' }), el('th', { text: 'Subject' }),
          el('th', { text: 'Updated' }), el('th', { text: 'Status' }),
        ])]),
        body,
      ]),
    ]));
  }

  root.append(el('div', { class: 'split' }, [
    listCard,
    el('div', { class: 'stack-4' }, [
      waCard,
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', { text: 'Send a message' })]),
        el('div', { class: 'card-body' }, [form]),
      ]),
    ]),
  ]));
  return root;
}

export async function renderSupportThread([ref]) {
  const data = await api.get(`/api/support/${encodeURIComponent(ref)}`);
  const root = el('div', { class: 'stack-6', style: 'max-width:760px' });

  root.append(el('a', { class: 'back-link', href: '#/support' }, [icon('chat', 14), el('span', { text: 'All requests' })]));
  root.append(el('div', { class: 'page-head' }, [
    el('div', { class: 'row between' }, [
      el('div', {}, [
        el('h2', { text: data.request.subject }),
        el('p', {}, [el('span', { class: 'ref', text: data.request.ref }), ` · opened ${dateTime(data.request.createdAt)}`]),
      ]),
      el('span', { class: `badge badge-${statusTone(data.request.status)}`, text: statusLabel(data.request.status) }),
    ]),
  ]));

  const thread = el('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:var(--s-4)' },
    data.messages.map((m) => el('div', {
      style: `border:1px solid var(--ink-200);border-radius:var(--r-md);padding:var(--s-4);${
        m.authorType === 'admin' ? 'background:var(--brand-50);border-color:var(--brand-100)' : ''}`,
    }, [
      el('div', { class: 'row between', style: 'margin-bottom:var(--s-2)' }, [
        el('strong', { style: 'font-size:var(--t-base)', text: m.authorType === 'admin' ? `${m.author} · Support` : 'You' }),
        el('span', { class: 'muted', style: 'font-size:var(--t-xs)', text: dateTime(m.at) }),
      ]),
      el('div', { style: 'font-size:var(--t-base);white-space:pre-wrap', text: m.body }),
    ])));

  const replyForm = el('form', { novalidate: true }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'reply', text: 'Reply' }),
      el('textarea', { class: 'textarea', id: 'reply', name: 'reply', rows: '4', maxlength: '4000' }),
    ]),
    el('button', { class: 'btn btn-primary', type: 'submit', id: 'reply-submit', text: 'Send reply' }),
  ]);

  replyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const restore = busy($('#reply-submit'), 'Sending…');
    try {
      await api.post(`/api/support/${encodeURIComponent(ref)}/reply`, {
        message: replyForm.querySelector('#reply').value,
      });
      toast('Reply sent.', 'pos');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) { restore(); toast(error.message, 'neg'); }
  });

  root.append(el('div', { class: 'card' }, [
    thread,
    data.request.status === 'closed'
      ? el('div', { class: 'card-footer', text: 'This request is closed. Open a new one to continue the conversation.' })
      : el('div', { class: 'card-footer', style: 'background:var(--white)' }, [replyForm]),
  ]));

  return root;
}

/* ===========================================================================
   Notifications (full page)
   =========================================================================== */
export async function renderNotifications() {
  const data = await api.get('/api/notifications?limit=60');
  const root = el('div', { class: 'stack-6', style: 'max-width:760px' });
  root.append(pageHead('Notifications', 'Everything that has happened on your account.'));

  if (!data.items.length) {
    root.append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [emptyState({
      title: 'Nothing yet', body: 'Updates about deposits, withdrawals and your account appear here.',
    })])]));
    return root;
  }

  root.append(el('div', { class: 'card' }, data.items.map((n) => el('div', {
    class: `notif${n.read ? '' : ' unread'}`,
  }, [
    el('span', { class: 'notif-dot' }),
    el('div', { style: 'min-width:0;flex:1' }, [
      el('div', { class: 't', text: n.title }),
      el('div', { class: 'b', text: n.body }),
      el('div', { class: 'm', text: dateTime(n.createdAt) }),
    ]),
  ]))));
  return root;
}
