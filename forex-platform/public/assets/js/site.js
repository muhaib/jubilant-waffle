/*
 * Public site behaviour.
 *
 * Every figure on this page — the limits, the model parameters, the worked
 * example table, the support number, the marketing copy — is fetched from the
 * server, so an administrator changing a setting changes the page. Nothing
 * here is hard-coded except the fallback markup that ships in the HTML.
 */
import { api } from './api.js';
import { el, clear, $, $$ } from './ui.js';
import { money } from './format.js';

const state = { config: null, timer: null };

/* -- Mobile navigation ---------------------------------------------------- */
function initNav() {
  const toggle = $('#nav-toggle');
  const nav = $('#mobile-nav');
  if (!toggle || !nav) return;
  toggle.addEventListener('click', () => {
    const open = nav.dataset.open === 'true';
    nav.dataset.open = String(!open);
    toggle.setAttribute('aria-expanded', String(!open));
    toggle.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
  });
  $$('a', nav).forEach((link) => link.addEventListener('click', () => {
    nav.dataset.open = 'false';
    toggle.setAttribute('aria-expanded', 'false');
  }));
}

/* -- Calculator ----------------------------------------------------------- */
/**
 * The browser recomputes on every keystroke so the figures feel immediate,
 * but it uses the model parameters the server sent and re-checks the amount
 * against the server on settle. The server remains the authority: opening an
 * investment recalculates from scratch and re-validates the limits.
 */
function computeLocal(cents, model) {
  return {
    dailyCents: Math.round(cents / model.divisor),
    cycleCents: Math.round((cents * model.cycleDays) / model.divisor),
  };
}

function parseAmount(text) {
  const cleaned = String(text || '').replace(/[,\s$]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

function initCalculator(config) {
  const form = $('#calc-form');
  const input = $('#calc-amount');
  const slider = $('#calc-slider');
  const errorNode = $('#calc-error');
  const presetHost = $('#calc-presets');
  if (!form) return;

  const { minCents, maxCents, model, disclaimer } = config.investment;
  $('#calc-disclaimer').textContent = disclaimer;
  $('#calc-days').textContent = String(model.cycleDays);
  $('#calc-daily-note').textContent = `amount ÷ ${model.divisor}`;

  slider.min = String(Math.floor(minCents / 100));
  slider.max = String(Math.floor(maxCents / 100));
  slider.step = String(Math.max(1, Math.round(minCents / 100 / 3)));

  const presets = [minCents, 10000, 50000, 100000, 500000, maxCents]
    .filter((c, i, arr) => c >= minCents && c <= maxCents && arr.indexOf(c) === i);
  clear(presetHost).append(...presets.map((cents) => el('button', {
    type: 'button', text: money(cents).replace('.00', ''), dataset: { cents: String(cents) },
    'aria-pressed': 'false',
  })));

  function render(cents, { fromSlider = false } = {}) {
    const problems = [];
    if (cents === null) problems.push('Enter an amount such as 250 or 1,000.50.');
    else {
      if (cents < minCents) problems.push(`The minimum investment is ${money(minCents)}.`);
      if (cents > maxCents) problems.push(`The maximum investment is ${money(maxCents)}.`);
    }

    if (problems.length) {
      errorNode.textContent = problems[0];
      errorNode.style.display = '';
      form.querySelector('.amount-input').closest('form').classList.add('invalid');
    } else {
      errorNode.style.display = 'none';
    }

    const safe = Math.min(Math.max(cents ?? minCents, minCents), maxCents);
    const figures = computeLocal(safe, model);
    $('#calc-daily').textContent = money(figures.dailyCents);
    $('#calc-cycle').textContent = money(figures.cycleCents);

    if (!fromSlider) slider.value = String(Math.round(safe / 100));
    $$('button', presetHost).forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.cents) === safe));
    });

    // Confirm against the server once the user stops typing. If the browser
    // and the server ever disagree, the server's answer is the one shown.
    clearTimeout(state.timer);
    if (!problems.length) {
      state.timer = setTimeout(async () => {
        try {
          const result = await api.post('/api/public/calculator', { amount: (safe / 100).toFixed(2) });
          $('#calc-daily').textContent = money(result.illustrative.dailyCents);
          $('#calc-cycle').textContent = money(result.illustrative.cycleCents);
        } catch { /* the local figure already shown is correct for this model */ }
      }, 450);
    }
  }

  input.addEventListener('input', () => render(parseAmount(input.value)));
  slider.addEventListener('input', () => {
    input.value = slider.value;
    render(Number(slider.value) * 100, { fromSlider: true });
  });
  presetHost.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    const cents = Number(button.dataset.cents);
    input.value = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
    render(cents);
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  input.value = String(Math.floor(minCents / 100));
  render(minCents);
}

/* -- Worked example table ------------------------------------------------- */
async function initTable() {
  const body = $('#illus-table tbody');
  if (!body) return;
  try {
    const data = await api.get('/api/public/illustration-table');
    $('#illus-disclaimer').textContent = `Illustrative calculation only. ${data.disclaimer}`;
    clear(body).append(...data.rows.map((row) => el('tr', {}, [
      el('td', { class: 'primary', dataset: { label: 'Investment' }, text: money(row.principalCents) }),
      el('td', { class: 'num', dataset: { label: 'Example daily' }, text: money(row.dailyCents) }),
      el('td', { class: 'num', dataset: { label: `Example ${data.model.cycleDays}-day` }, text: money(row.cycleCents) }),
    ])));
  } catch {
    clear(body).append(el('tr', {}, [
      el('td', { colspan: '3', class: 'muted', text: 'The example table could not be loaded. Refresh the page to try again.' }),
    ]));
  }
}

/* -- Copy driven by the database ------------------------------------------ */
const FEATURE_ICONS = [
  '<path d="M20 6 9 17l-5-5"/>',
  '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
  '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>',
  '<path d="M16 21v-2a4 4 0 0 0-8 0v2"/><circle cx="12" cy="7" r="4"/>',
  '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>',
  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
];

function applyContent(config) {
  document.querySelectorAll('[data-platform-name]').forEach((n) => { n.textContent = config.platformName; });
  document.title = `${config.platformName} — Forex investment accounts`;

  const content = config.content || {};
  if (content.heroHeadline) $('[data-content="heroHeadline"]').textContent = content.heroHeadline;
  if (content.heroSubhead) $('[data-content="heroSubhead"]').textContent = content.heroSubhead;

  const { minCents, maxCents, model } = config.investment;
  $$('[data-fact="min"]').forEach((n) => { n.textContent = money(minCents).replace('.00', ''); });
  $$('[data-fact="max"]').forEach((n) => { n.textContent = money(maxCents).replace('.00', ''); });
  $$('[data-fact="cycle"]').forEach((n) => { n.textContent = String(model.cycleDays); });
  $$('[data-fact="cycle-inline"]').forEach((n) => { n.textContent = String(model.cycleDays); });
  $$('[data-fact="divisor-inline"]').forEach((n) => { n.textContent = String(model.divisor); });

  const grid = $('#why-grid');
  if (grid && Array.isArray(content.whyPlatform)) {
    clear(grid).append(...content.whyPlatform.map((item, i) => el('div', { class: 'feature' }, [
      el('div', {
        class: 'feature-icon',
        html: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FEATURE_ICONS[i % FEATURE_ICONS.length]}</svg>`,
      }),
      el('h4', { text: item.title }),
      el('p', { text: item.body }),
    ])));
  }

  const support = config.support || {};
  const cta = $('#whatsapp-cta');
  if (cta) {
    if (support.whatsappDigits) {
      cta.href = `https://wa.me/${support.whatsappDigits}?text=${encodeURIComponent('Hello, I have a question about opening an account.')}`;
      cta.target = '_blank';
    } else {
      cta.remove();
    }
  }
  const hours = $('#support-hours');
  if (hours) {
    // Never claim round-the-clock human cover: state the configured hours.
    hours.textContent = support.hours
      ? `Human agents: ${support.hours}. Messages outside these hours are answered when the team is next available.`
      : 'Messages are answered during our published support hours.';
  }
  const footerSupport = $('#footer-support');
  if (footerSupport && support.whatsappDisplay) {
    footerSupport.textContent = `WhatsApp support: ${support.whatsappDisplay} · ${support.hours || ''}`.trim();
  }
}

/* -- Boot ----------------------------------------------------------------- */
async function boot() {
  initNav();
  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  try {
    state.config = await api.get('/api/public/config');
    applyContent(state.config);
    initCalculator(state.config);
  } catch {
    // The page still works from the markup that shipped with it; only the
    // live configuration is missing.
    const errorNode = $('#calc-error');
    if (errorNode) {
      errorNode.textContent = 'Live figures could not be loaded. Refresh the page to try again.';
      errorNode.style.display = '';
    }
  }
  initTable();
}

boot();
