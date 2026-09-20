/*
 * Account application.
 *
 * A hash router over a small set of views. The client renders; it never
 * decides. Balances, statuses, eligibility and limits all arrive from the
 * server on each view, and any control the server would reject is either
 * absent or explains why it is unavailable.
 */
import { api, ApiError } from '/assets/js/api.js';
import { el, clear, $, toast, skeletonRows, errorState } from '/assets/js/ui.js';
import { relative } from '/assets/js/format.js';
import { icon } from './icons.js';
import * as money from './views-money.js';
import * as account from './views-account.js';
import { renderDashboard } from './view-dashboard.js';

export const store = {
  config: null,
  user: null,
  balances: null,
  unread: 0,
};

/* -- Navigation definition ------------------------------------------------ */
const NAV = [
  { group: 'Overview', items: [
    { path: '/', label: 'Dashboard', icon: 'home' },
    { path: '/investments', label: 'Investments', icon: 'chart' },
    { path: '/transactions', label: 'Transactions', icon: 'list' },
  ] },
  { group: 'Money', items: [
    { path: '/deposit', label: 'Make a deposit', icon: 'download' },
    { path: '/deposits', label: 'Deposit history', icon: 'receipt' },
    { path: '/withdraw', label: 'Withdraw', icon: 'upload' },
    { path: '/withdrawals', label: 'Withdrawal history', icon: 'receipt' },
  ] },
  { group: 'Account', items: [
    { path: '/verification', label: 'Verification', icon: 'shield' },
    { path: '/security', label: 'Security', icon: 'lock' },
    { path: '/activity', label: 'Account activity', icon: 'activity' },
    { path: '/support', label: 'Support', icon: 'chat' },
  ] },
];

const TABS = [
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/deposit', label: 'Deposit', icon: 'download' },
  { path: '/withdraw', label: 'Withdraw', icon: 'upload' },
  { path: '/transactions', label: 'History', icon: 'list' },
  { path: '/support', label: 'Support', icon: 'chat' },
];

const ROUTES = [
  { pattern: /^\/$/, title: 'Dashboard', render: renderDashboard },
  { pattern: /^\/verify$/, title: 'Verify your number', render: account.renderVerify, bare: true },
  { pattern: /^\/deposit$/, title: 'Make a deposit', render: money.renderDepositForm },
  { pattern: /^\/deposits$/, title: 'Deposit history', render: money.renderDeposits },
  { pattern: /^\/deposits\/([\w-]+)$/, title: 'Deposit', render: money.renderDepositDetail },
  { pattern: /^\/withdraw$/, title: 'Withdraw funds', render: money.renderWithdrawForm },
  { pattern: /^\/withdrawals$/, title: 'Withdrawal history', render: money.renderWithdrawals },
  { pattern: /^\/withdrawals\/([\w-]+)$/, title: 'Withdrawal', render: money.renderWithdrawalDetail },
  { pattern: /^\/investments$/, title: 'Investments', render: money.renderInvestments },
  { pattern: /^\/transactions$/, title: 'Transactions', render: money.renderTransactions },
  { pattern: /^\/verification$/, title: 'Verification', render: account.renderVerification },
  { pattern: /^\/security$/, title: 'Security', render: account.renderSecurity },
  { pattern: /^\/activity$/, title: 'Account activity', render: account.renderActivity },
  { pattern: /^\/support$/, title: 'Support', render: account.renderSupport },
  { pattern: /^\/support\/([\w-]+)$/, title: 'Support request', render: account.renderSupportThread },
  { pattern: /^\/notifications$/, title: 'Notifications', render: account.renderNotifications },
];

export function go(path) {
  window.location.hash = `#${path}`;
}

/* -- Shell ---------------------------------------------------------------- */
function navLink(item, currentPath) {
  return el('a', {
    class: 'nav-item', href: `#${item.path}`,
    'aria-current': item.path === currentPath ? 'page' : null,
  }, [icon(item.icon), el('span', { text: item.label })]);
}

function buildShell() {
  const sidebar = el('nav', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Account sections' }, [
    el('a', { class: 'sidebar-brand', href: '/' }, [
      el('span', { class: 'brand-mark', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17.5 9 11l4 4 8-9"/><path d="M21 6v5h-5"/></svg>' }),
      el('span', { id: 'brand-name', text: 'Meridian FX' }),
    ]),
    el('div', { class: 'sidebar-nav', id: 'sidebar-nav' }),
    el('div', { class: 'sidebar-foot' }, [
      el('div', { text: 'Signed in as' }),
      el('div', { class: 'acct', id: 'foot-account', text: '—' }),
      el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', id: 'sign-out',
        style: 'color:#b3c2d6;padding-left:0;margin-top:8px', text: 'Sign out',
      }),
    ]),
  ]);

  const main = el('div', { class: 'main-panel' }, [
    el('header', { class: 'topbar' }, [
      el('button', { class: 'icon-btn menu-btn', type: 'button', id: 'menu-btn', 'aria-label': 'Open menu' }, [icon('menu')]),
      el('h1', { id: 'page-title', text: 'Dashboard' }),
      el('div', { class: 'spacer' }),
      el('a', {
        class: 'btn btn-secondary btn-sm', id: 'whatsapp-top', href: '#/support',
        style: 'display:none',
      }, [icon('whatsapp'), el('span', { text: 'WhatsApp' })]),
      el('button', { class: 'icon-btn', type: 'button', id: 'notif-btn', 'aria-label': 'Notifications' }, [icon('bell')]),
    ]),
    el('main', { class: 'page', id: 'view', tabindex: '-1' }),
  ]);

  return el('div', {
    class: 'shell', id: 'shell', 'data-nav': 'closed',
  }, [
    sidebar,
    el('div', { class: 'nav-scrim', id: 'nav-scrim' }),
    main,
    el('nav', { class: 'tabbar', id: 'tabbar', 'aria-label': 'Quick navigation' }),
  ]);
}

function renderNav(currentPath) {
  const host = clear($('#sidebar-nav'));
  for (const group of NAV) {
    host.append(el('div', { class: 'nav-group-label', text: group.group }));
    for (const item of group.items) host.append(navLink(item, currentPath));
  }

  const tabs = clear($('#tabbar'));
  for (const tab of TABS) {
    tabs.append(el('a', {
      href: `#${tab.path}`, 'aria-current': tab.path === currentPath ? 'page' : null,
    }, [icon(tab.icon), el('span', { text: tab.label })]));
  }
}

function closeNav() { $('#shell')?.setAttribute('data-nav', 'closed'); }

/* -- Notifications panel -------------------------------------------------- */
let panel = null;

async function toggleNotifications() {
  if (panel) { panel.remove(); panel = null; return; }
  panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Notifications' }, [
    el('div', { class: 'panel-head' }, [
      el('h4', { text: 'Notifications' }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Mark all read', id: 'mark-all' }),
    ]),
    el('div', { class: 'panel-list', id: 'panel-list' }, [
      el('div', { style: 'padding:16px' }, [skeletonRows(3)]),
    ]),
  ]);
  document.body.append(panel);

  const dismiss = (event) => {
    if (!panel) return;
    if (panel.contains(event.target) || event.target.closest('#notif-btn')) return;
    panel.remove(); panel = null;
    document.removeEventListener('mousedown', dismiss);
  };
  document.addEventListener('mousedown', dismiss);

  try {
    const data = await api.get('/api/notifications?limit=20');
    store.unread = data.unread;
    updateBell();
    const list = clear($('#panel-list'));
    if (!data.items.length) {
      list.append(el('div', { class: 'empty', style: 'padding:40px 24px' }, [
        el('h4', { text: 'Nothing yet' }),
        el('p', { text: 'Updates about your deposits, withdrawals and account appear here.' }),
      ]));
    } else {
      for (const item of data.items) {
        list.append(el('div', { class: `notif${item.read ? '' : ' unread'}` }, [
          el('span', { class: 'notif-dot' }),
          el('div', { style: 'min-width:0' }, [
            el('div', { class: 't', text: item.title }),
            el('div', { class: 'b', text: item.body }),
            el('div', { class: 'm', text: relative(item.createdAt) }),
          ]),
        ]));
      }
    }
    $('#mark-all').addEventListener('click', async () => {
      await api.post('/api/notifications/read', {});
      store.unread = 0;
      updateBell();
      panel?.querySelectorAll('.notif.unread').forEach((n) => n.classList.remove('unread'));
    });
  } catch (error) {
    clear($('#panel-list')).append(errorState(error));
  }
}

function updateBell() {
  const button = $('#notif-btn');
  if (!button) return;
  const existing = button.querySelector('.dot');
  if (store.unread > 0 && !existing) button.append(el('span', { class: 'dot' }));
  if (store.unread === 0 && existing) existing.remove();
}

/* -- Router --------------------------------------------------------------- */
let renderToken = 0;

async function route() {
  const path = window.location.hash.replace(/^#/, '') || '/';
  closeNav();
  $('#shell')?.setAttribute('data-locked', String(!store.user?.phoneVerified));

  // An unverified account can only reach the verification view.
  if (store.user && !store.user.phoneVerified && path !== '/verify') {
    go('/verify');
    return;
  }
  if (store.user?.phoneVerified && path === '/verify') { go('/'); return; }

  const match = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).find((x) => x.m);
  const view = $('#view');
  if (!view) return;

  if (!match) {
    clear(view).append(el('div', { class: 'card' }, [
      el('div', { class: 'card-body' }, [
        el('div', { class: 'empty' }, [
          el('h4', { text: 'Page not found' }),
          el('p', { text: 'That section of your account does not exist.' }),
          el('a', { class: 'btn btn-secondary', href: '#/', text: 'Back to dashboard' }),
        ]),
      ]),
    ]));
    return;
  }

  $('#page-title').textContent = match.r.title;
  document.title = `${match.r.title} — ${store.config?.platformName || 'Account'}`;
  renderNav(path);

  const token = ++renderToken;
  clear(view).append(el('div', { class: 'card' }, [
    el('div', { class: 'card-body' }, [skeletonRows(4, 14)]),
  ]));

  try {
    const content = await match.r.render(match.m.slice(1));
    if (token !== renderToken) return;      // a newer navigation won
    clear(view).append(content);
    view.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  } catch (error) {
    if (token !== renderToken) return;
    if (error instanceof ApiError && error.isAuth) { window.location.href = '/login.html'; return; }
    clear(view).append(el('div', { class: 'card' }, [
      el('div', { class: 'card-body' }, [errorState(error, () => route())]),
    ]));
  }
}

/* -- Boot ----------------------------------------------------------------- */
async function boot() {
  let session;
  try {
    [store.config, session] = await Promise.all([
      api.get('/api/public/config'),
      api.get('/api/auth/session'),
    ]);
  } catch {
    document.getElementById('root').innerHTML = '';
    document.getElementById('root').append(el('div', {
      style: 'min-height:100vh;display:grid;place-items:center;padding:24px',
    }, [errorState({ message: 'Could not reach the server. Check your connection and refresh.' })]));
    return;
  }

  if (!session.authenticated) { window.location.href = '/login.html'; return; }
  store.user = session.user;

  const root = clear(document.getElementById('root'));
  root.removeAttribute('aria-busy');
  root.append(buildShell());

  $('#brand-name').textContent = store.config.platformName;
  $('#foot-account').textContent = store.user.publicId;

  const support = store.config.support || {};
  if (support.whatsappDigits) {
    const link = $('#whatsapp-top');
    link.href = `https://wa.me/${support.whatsappDigits}?text=${encodeURIComponent(`Hello, my account ID is ${store.user.publicId}.`)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.display = '';
  }

  $('#menu-btn').addEventListener('click', () => {
    const shell = $('#shell');
    shell.setAttribute('data-nav', shell.getAttribute('data-nav') === 'open' ? 'closed' : 'open');
  });
  $('#nav-scrim').addEventListener('click', closeNav);
  $('#notif-btn').addEventListener('click', toggleNotifications);
  $('#sign-out').addEventListener('click', async () => {
    try { await api.post('/api/auth/logout', {}); } catch { /* sign out locally regardless */ }
    window.location.href = '/';
  });

  window.addEventListener('hashchange', route);
  await route();

  // Refresh the unread count in the background; a failure here is silent.
  try {
    const data = await api.get('/api/notifications?limit=1');
    store.unread = data.unread;
    updateBell();
  } catch { /* not important enough to surface */ }
}

boot();
