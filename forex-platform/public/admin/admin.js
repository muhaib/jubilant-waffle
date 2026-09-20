/*
 * Administrator console.
 *
 * The UI hides controls an administrator's role does not permit, but that is
 * only a courtesy — every one of these endpoints re-checks the permission on
 * the server. Hiding a button is never the access control.
 */
import { api, ApiError } from '/assets/js/api.js';
import { el, clear, $, toast, skeletonRows, errorState, busy, applyFieldErrors, clearFieldErrors } from '/assets/js/ui.js';
import { icon } from '/app/icons.js';
import * as queue from './views-queue.js';
import * as manage from './views-manage.js';
import { renderOverview } from './view-overview.js';

export const admin = { me: null, config: null };

export function can(...keys) {
  return keys.some((k) => admin.me?.permissions.includes(k));
}

export function go(path) { window.location.hash = `#${path}`; }

const NAV = [
  { group: 'Operations', items: [
    { path: '/', label: 'Overview', icon: 'home', perm: ['users.view', 'deposits.view', 'withdrawals.view'] },
    { path: '/deposits', label: 'Deposits', icon: 'download', perm: ['deposits.view'] },
    { path: '/withdrawals', label: 'Withdrawals', icon: 'upload', perm: ['withdrawals.view'] },
    { path: '/ledger', label: 'Ledger', icon: 'ledger', perm: ['ledger.view'] },
  ] },
  { group: 'People', items: [
    { path: '/users', label: 'Users', icon: 'users', perm: ['users.view'] },
    { path: '/risk', label: 'Risk flags', icon: 'flag', perm: ['risk.view'] },
    { path: '/support', label: 'Support', icon: 'chat', perm: ['support.view'] },
  ] },
  { group: 'Platform', items: [
    { path: '/settings', label: 'Settings', icon: 'settings', perm: ['settings.view'] },
    { path: '/payments', label: 'Payment methods', icon: 'ledger', perm: ['settings.view'] },
    { path: '/content', label: 'Content & legal', icon: 'file', perm: ['settings.view'] },
    { path: '/audit', label: 'Audit log', icon: 'activity', perm: ['audit.view'] },
    { path: '/admins', label: 'Administrators', icon: 'shield', perm: ['admins.manage'] },
  ] },
];

const ROUTES = [
  { pattern: /^\/$/, title: 'Overview', render: renderOverview },
  { pattern: /^\/deposits$/, title: 'Deposits', render: queue.renderDeposits },
  { pattern: /^\/deposits\/([\w-]+)$/, title: 'Deposit review', render: queue.renderDepositReview },
  { pattern: /^\/withdrawals$/, title: 'Withdrawals', render: queue.renderWithdrawals },
  { pattern: /^\/withdrawals\/([\w-]+)$/, title: 'Withdrawal review', render: queue.renderWithdrawalReview },
  { pattern: /^\/ledger$/, title: 'Ledger', render: queue.renderLedger },
  { pattern: /^\/risk$/, title: 'Risk flags', render: queue.renderRisk },
  { pattern: /^\/support$/, title: 'Support', render: queue.renderSupport },
  { pattern: /^\/support\/([\w-]+)$/, title: 'Support request', render: queue.renderSupportThread },
  { pattern: /^\/users$/, title: 'Users', render: manage.renderUsers },
  { pattern: /^\/users\/([\w-]+)$/, title: 'User', render: manage.renderUserDetail },
  { pattern: /^\/settings$/, title: 'Settings', render: manage.renderSettings },
  { pattern: /^\/payments$/, title: 'Payment methods', render: manage.renderPayments },
  { pattern: /^\/content$/, title: 'Content & legal', render: manage.renderContent },
  { pattern: /^\/audit$/, title: 'Audit log', render: manage.renderAudit },
  { pattern: /^\/admins$/, title: 'Administrators', render: manage.renderAdmins },
  { pattern: /^\/password$/, title: 'Change password', render: renderPasswordView },
];

/* -- Sign-in -------------------------------------------------------------- */
function renderLogin() {
  const form = el('form', { novalidate: true, id: 'admin-login' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'email', text: 'Email address' }),
      el('input', { class: 'input', type: 'email', id: 'email', name: 'email', autocomplete: 'username', autofocus: true }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'password', text: 'Password' }),
      el('input', { class: 'input', type: 'password', id: 'password', name: 'password', autocomplete: 'current-password' }),
    ]),
    el('div', { id: 'login-error' }),
    el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', id: 'login-submit', text: 'Sign in' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    clear($('#login-error'));
    const restore = busy($('#login-submit'), 'Signing in…');
    try {
      const result = await api.post('/api/admin/auth/login', {
        email: form.querySelector('#email').value,
        password: form.querySelector('#password').value,
      });
      admin.me = result.admin;
      window.location.reload();
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(form, error.fields)) return;
      clear($('#login-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  return el('div', {
    style: 'min-height:100vh;display:grid;place-items:center;padding:var(--s-6);background:var(--brand-900)',
  }, [
    el('div', { style: 'width:100%;max-width:420px' }, [
      el('div', { class: 'brand', style: 'color:#fff;margin-bottom:var(--s-6);justify-content:center' }, [
        el('span', { class: 'brand-mark', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17.5 9 11l4 4 8-9"/><path d="M21 6v5h-5"/></svg>' }),
        el('span', { text: 'Administrator console' }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-body' }, [form]),
        el('div', { class: 'card-footer', text: 'Administrator sessions are shorter than user sessions and every action you take here is written to an append-only audit log.' }),
      ]),
    ]),
  ]);
}

/* -- Forced password change ----------------------------------------------- */
async function renderPasswordView() {
  const form = el('form', { novalidate: true, id: 'pw-form' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'current_password', text: 'Current password' }),
      el('input', { class: 'input', type: 'password', id: 'current_password', name: 'current_password', autocomplete: 'current-password' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'new_password', text: 'New password' }),
      el('input', { class: 'input', type: 'password', id: 'new_password', name: 'new_password', autocomplete: 'new-password' }),
      el('p', { class: 'hint', text: 'At least 12 characters for an administrator, with upper and lower case letters and a number.' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', for: 'confirm_password', text: 'Confirm new password' }),
      el('input', { class: 'input', type: 'password', id: 'confirm_password', name: 'confirm_password', autocomplete: 'new-password' }),
    ]),
    el('div', { id: 'pw-error' }),
    el('button', { class: 'btn btn-primary btn-block', type: 'submit', id: 'pw-submit', text: 'Change password' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    clear($('#pw-error'));
    const restore = busy($('#pw-submit'), 'Changing…');
    try {
      await api.post('/api/admin/auth/password', {
        current_password: form.querySelector('#current_password').value,
        new_password: form.querySelector('#new_password').value,
        confirm_password: form.querySelector('#confirm_password').value,
      });
      toast('Password changed.', 'pos');
      window.location.hash = '#/';
      window.location.reload();
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields && applyFieldErrors(form, error.fields)) return;
      clear($('#pw-error')).append(el('div', {
        class: 'notice notice-neg', style: 'margin-bottom:var(--s-4)',
      }, [el('div', { text: error.message })]));
    }
  });

  return el('div', { style: 'max-width:480px' }, [
    admin.me.mustChangePassword
      ? el('div', { class: 'notice notice-warn', style: 'margin-bottom:var(--s-5)' }, [
        el('div', {}, [
          el('strong', { text: 'Change your password before continuing' }),
          el('span', { text: 'This account still uses the password it was created with. Set your own before using the console.' }),
        ]),
      ])
      : null,
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', { text: 'Change your password' })]),
      el('div', { class: 'card-body' }, [form]),
    ]),
  ]);
}

/* -- Shell ---------------------------------------------------------------- */
function buildShell() {
  return el('div', { class: 'shell', id: 'shell', 'data-nav': 'closed' }, [
    el('nav', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Console sections' }, [
      el('a', { class: 'sidebar-brand', href: '#/' }, [
        el('span', { class: 'brand-mark', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17.5 9 11l4 4 8-9"/><path d="M21 6v5h-5"/></svg>' }),
        el('span', { id: 'brand-name', text: 'Console' }),
      ]),
      el('div', { class: 'sidebar-nav', id: 'sidebar-nav' }),
      el('div', { class: 'sidebar-foot' }, [
        el('div', { id: 'admin-name', text: '' }),
        el('div', { class: 'acct', id: 'admin-role', text: '' }),
        el('a', { href: '#/password', style: 'color:#b3c2d6;font-size:var(--t-xs);display:block;margin-top:8px', text: 'Change password' }),
        el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', id: 'sign-out',
          style: 'color:#b3c2d6;padding-left:0', text: 'Sign out',
        }),
      ]),
    ]),
    el('div', { class: 'nav-scrim', id: 'nav-scrim' }),
    el('div', { class: 'main-panel' }, [
      el('header', { class: 'topbar' }, [
        el('button', { class: 'icon-btn menu-btn', type: 'button', id: 'menu-btn', 'aria-label': 'Open menu' }, [icon('menu')]),
        el('h1', { id: 'page-title', text: 'Overview' }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'badge badge-info', id: 'role-badge', text: '' }),
      ]),
      el('main', { class: 'page', id: 'view', tabindex: '-1' }),
    ]),
  ]);
}

function renderNav(currentPath) {
  const host = clear($('#sidebar-nav'));
  for (const group of NAV) {
    const visible = group.items.filter((item) => can(...item.perm));
    if (!visible.length) continue;
    host.append(el('div', { class: 'nav-group-label', text: group.group }));
    for (const item of visible) {
      host.append(el('a', {
        class: 'nav-item', href: `#${item.path}`,
        'aria-current': item.path === currentPath ? 'page' : null,
      }, [icon(item.icon), el('span', { text: item.label })]));
    }
  }
}

let renderToken = 0;

async function route() {
  const path = window.location.hash.replace(/^#/, '') || '/';
  $('#shell')?.setAttribute('data-nav', 'closed');

  // An administrator on a password issued by someone else cannot use the
  // console until they have replaced it.
  if (admin.me.mustChangePassword && path !== '/password') { go('/password'); return; }

  const match = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).find((x) => x.m);
  const view = $('#view');
  if (!match) {
    clear(view).append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [
      el('div', { class: 'empty' }, [
        el('h4', { text: 'Page not found' }),
        el('a', { class: 'btn btn-secondary', href: '#/', text: 'Back to overview' }),
      ]),
    ])]));
    return;
  }

  $('#page-title').textContent = match.r.title;
  document.title = `${match.r.title} — Console`;
  renderNav(path);

  const token = ++renderToken;
  clear(view).append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [skeletonRows(4, 14)])]));

  try {
    const content = await match.r.render(match.m.slice(1));
    if (token !== renderToken) return;
    clear(view).append(content);
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (error) {
    if (token !== renderToken) return;
    if (error instanceof ApiError && error.isAuth) { window.location.reload(); return; }
    clear(view).append(el('div', { class: 'card' }, [el('div', { class: 'card-body' }, [
      error instanceof ApiError && error.status === 403
        ? el('div', { class: 'empty' }, [
          el('h4', { text: 'Not permitted' }),
          el('p', { text: error.message }),
          el('a', { class: 'btn btn-secondary', href: '#/', text: 'Back to overview' }),
        ])
        : errorState(error, () => route()),
    ])]));
  }
}

async function boot() {
  let session;
  try {
    [admin.config, session] = await Promise.all([
      api.get('/api/public/config'),
      api.get('/api/admin/auth/session'),
    ]);
  } catch {
    const root = clear(document.getElementById('root'));
    root.append(el('div', { style: 'min-height:100vh;display:grid;place-items:center;padding:24px' },
      [errorState({ message: 'Could not reach the server. Refresh to try again.' })]));
    return;
  }

  const root = clear(document.getElementById('root'));
  root.removeAttribute('aria-busy');

  if (!session.authenticated) { root.append(renderLogin()); return; }
  admin.me = session.admin;

  root.append(buildShell());
  $('#brand-name').textContent = `${admin.config.platformName} console`;
  $('#admin-name').textContent = admin.me.name;
  $('#admin-role').textContent = admin.me.publicId;
  $('#role-badge').textContent = admin.me.roleName;

  $('#menu-btn').addEventListener('click', () => {
    const shell = $('#shell');
    shell.setAttribute('data-nav', shell.getAttribute('data-nav') === 'open' ? 'closed' : 'open');
  });
  $('#nav-scrim').addEventListener('click', () => $('#shell').setAttribute('data-nav', 'closed'));
  $('#sign-out').addEventListener('click', async () => {
    try { await api.post('/api/admin/auth/logout', {}); } catch { /* sign out locally regardless */ }
    window.location.reload();
  });

  window.addEventListener('hashchange', route);
  await route();
}

boot();
