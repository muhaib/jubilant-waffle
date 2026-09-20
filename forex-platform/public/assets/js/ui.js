/* Small DOM helpers, toasts, confirmation dialogs and skeletons. */

/** Create an element. Text is always set via textContent, never innerHTML. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;           // only for trusted markup we build ourselves
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* -- Toasts -------------------------------------------------------------- */
function toastHost() {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

export function toast(message, tone = 'info', timeout = 5000) {
  const node = el('div', { class: `toast ${tone === 'info' ? '' : tone}`.trim() }, [
    el('div', { text: message, style: 'flex:1' }),
    el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', text: '×',
      onclick: () => node.remove() }),
  ]);
  toastHost().append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

/* -- Confirmation -------------------------------------------------------- */
/**
 * Every irreversible action goes through here. Resolves to the note the
 * operator typed (or true when no note is required), or false on cancel.
 */
export function confirmDialog({
  title, body, confirmLabel = 'Confirm', tone = 'primary',
  requireNote = false, noteLabel = 'Reason', notePlaceholder = '', noteMinLength = 8,
  checkboxLabel = null,
}) {
  return new Promise((resolve) => {
    const noteField = requireNote
      ? el('div', { class: 'field' }, [
        el('label', { class: 'label', for: 'confirm-note', text: noteLabel }),
        el('textarea', { class: 'textarea', id: 'confirm-note', placeholder: notePlaceholder }),
        el('p', { class: 'error-text', id: 'confirm-note-error', style: 'display:none' }),
      ])
      : null;

    const checkbox = checkboxLabel
      ? el('div', { class: 'checkline' }, [
        el('input', { type: 'checkbox', id: 'confirm-check' }),
        el('label', { for: 'confirm-check', text: checkboxLabel }),
      ])
      : null;

    const confirmBtn = el('button', {
      class: `btn btn-${tone}`, type: 'button', text: confirmLabel,
    });
    const cancelBtn = el('button', { class: 'btn btn-secondary', type: 'button', text: 'Cancel' });

    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('div', { class: 'modal-header' }, [el('h3', { text: title })]),
      el('div', { class: 'modal-body' }, [
        typeof body === 'string' ? el('p', { text: body, class: 'muted' }) : body,
        noteField, checkbox,
      ]),
      el('div', { class: 'modal-footer' }, [cancelBtn, confirmBtn]),
    ]);
    const backdrop = el('div', { class: 'modal-backdrop' }, [modal]);

    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };

    confirmBtn.addEventListener('click', () => {
      if (checkbox && !checkbox.querySelector('input').checked) {
        toast('Tick the confirmation box to continue.', 'warn');
        return;
      }
      if (requireNote) {
        const input = noteField.querySelector('textarea');
        const value = input.value.trim();
        const err = noteField.querySelector('#confirm-note-error');
        if (value.length < noteMinLength) {
          err.textContent = `Enter at least ${noteMinLength} characters so the reason is on the record.`;
          err.style.display = '';
          noteField.classList.add('invalid');
          input.focus();
          return;
        }
        close(value);
        return;
      }
      close(true);
    });
    cancelBtn.addEventListener('click', () => close(false));
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', onKey);

    document.body.append(backdrop);
    (noteField?.querySelector('textarea') || confirmBtn).focus();
  });
}

/* -- Form helpers -------------------------------------------------------- */
export function clearFieldErrors(form) {
  $$('.field.invalid', form).forEach((f) => f.classList.remove('invalid'));
  $$('.error-text[data-field]', form).forEach((n) => n.remove());
}

/** Attach server-side validation messages to the fields they belong to. */
export function applyFieldErrors(form, fields = {}) {
  clearFieldErrors(form);
  let first = null;
  for (const [name, message] of Object.entries(fields)) {
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (!input) continue;
    const field = input.closest('.field') || input.closest('.checkline')?.parentElement || input.parentElement;
    field?.classList.add('invalid');
    const holder = input.closest('.field') || field;
    holder?.append(el('p', { class: 'error-text', dataset: { field: name }, text: message }));
    if (!first) first = input;
  }
  if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  return Boolean(first);
}

/** Put a button into its pending state and return a restore function. */
export function busy(button, label = 'Working…') {
  const original = button.textContent;
  button.disabled = true;
  clear(button).append(el('span', { class: 'spinner' }), document.createTextNode(` ${label}`));
  return () => { button.disabled = false; button.textContent = original; };
}

export function skeletonRows(count = 3, height = 12) {
  return el('div', {}, Array.from({ length: count }, (_, i) => el('div', {
    class: 'skeleton skeleton-line',
    style: `height:${height}px;width:${[92, 78, 64, 85][i % 4]}%`,
  })));
}

export function emptyState({ title, body, action }) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-icon', html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 12h18M3 17h10"/></svg>' }),
    el('h4', { text: title }),
    body ? el('p', { text: body }) : null,
    action || null,
  ]);
}

export function errorState(error, retry) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-icon', style: 'background:var(--neg-50);color:var(--neg-600)',
      html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>' }),
    el('h4', { text: 'That did not load' }),
    el('p', { text: error?.message || 'Something went wrong.' }),
    retry ? el('button', { class: 'btn btn-secondary', type: 'button', text: 'Try again', onclick: retry }) : null,
  ]);
}

export function badge(status, label) {
  return el('span', { class: `badge badge-${status.tone}`, text: label ?? status.label });
}

/** Render restricted Markdown (headings, bold, lists, paragraphs) safely. */
export function renderMarkdown(source) {
  const root = el('div', { class: 'prose' });
  const blocks = String(source || '').split(/\n{2,}/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (block.startsWith('## ')) { root.append(el('h3', { text: block.slice(3) })); continue; }
    if (block.startsWith('# ')) { root.append(el('h2', { text: block.slice(2) })); continue; }
    if (/^[-*]\s/m.test(block)) {
      const ul = el('ul');
      for (const line of block.split('\n')) {
        const item = line.replace(/^[-*]\s+/, '').trim();
        if (item) ul.append(el('li', { text: item }));
      }
      root.append(ul);
      continue;
    }
    root.append(el('p', { text: block.replace(/\n/g, ' ') }));
  }
  return root;
}
