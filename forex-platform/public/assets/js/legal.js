/* Legal pages. The text is stored in the database and edited by an
   administrator, so it is rendered through a restricted Markdown renderer
   that only ever sets textContent — never innerHTML from stored copy. */
import { api } from './api.js';
import { el, clear, $, renderMarkdown } from './ui.js';

const DOCS = [
  ['risk_disclosure', 'Risk Disclosure'],
  ['terms', 'Terms & Conditions'],
  ['privacy', 'Privacy Policy'],
  ['program_terms', 'Investment Programme Terms'],
];

function currentKey() {
  const hash = window.location.hash.replace('#', '');
  return DOCS.some(([k]) => k === hash) ? hash : DOCS[0][0];
}

function renderNav(active) {
  clear($('#legal-nav')).append(...DOCS.map(([key, label]) => el('a', {
    href: `#${key}`, text: label, 'aria-current': String(key === active),
  })));
}

async function load() {
  const key = currentKey();
  renderNav(key);
  const body = $('#legal-body');
  clear(body).append(
    el('div', { class: 'skeleton skeleton-line', style: 'width:90%' }),
    el('div', { class: 'skeleton skeleton-line', style: 'width:72%' }),
    el('div', { class: 'skeleton skeleton-line', style: 'width:84%' }),
  );
  try {
    const doc = await api.get(`/api/public/content/${encodeURIComponent(key)}`);
    $('#legal-title').textContent = doc.title;
    document.title = `${doc.title} — Meridian FX`;
    $('#legal-updated').textContent = doc.updatedAt ? `Last updated ${doc.updatedAt.slice(0, 10)}` : '';
    clear(body).append(renderMarkdown(doc.body));
  } catch (error) {
    clear(body).append(el('div', { class: 'notice notice-neg' }, [
      el('div', { text: error.message || 'This document could not be loaded.' }),
    ]));
  }
}

api.get('/api/public/config').then((config) => {
  document.querySelectorAll('[data-platform-name]').forEach((n) => { n.textContent = config.platformName; });
}).catch(() => {});

window.addEventListener('hashchange', load);
load();
