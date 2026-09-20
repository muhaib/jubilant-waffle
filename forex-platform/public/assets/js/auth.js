/* Registration and sign-in. Both pages share this module. */
import { api, ApiError } from './api.js';
import { el, clear, $, applyFieldErrors, clearFieldErrors, busy, toast } from './ui.js';
import { deviceSignal } from './device.js';

function showFormError(node, message) {
  clear(node).append(el('div', { class: 'notice notice-neg' }, [
    el('svg', {}, []),
    el('div', { text: message }),
  ]));
  node.style.display = '';
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function hideFormError(node) { node.style.display = 'none'; clear(node); }

/* -- Password strength ---------------------------------------------------- */
function passwordFeedback(value) {
  const checks = [
    [value.length >= 10, 'at least 10 characters'],
    [/[a-z]/.test(value), 'a lowercase letter'],
    [/[A-Z]/.test(value), 'an uppercase letter'],
    [/\d/.test(value), 'a number'],
  ];
  const missing = checks.filter(([ok]) => !ok).map(([, text]) => text);
  if (!value) return { ok: false, text: 'Use at least 10 characters with upper and lower case letters and a number.' };
  if (missing.length) return { ok: false, text: `Still needs ${missing.join(', ')}.` };
  return { ok: true, text: 'That meets the minimum requirements.' };
}

/* -- Registration --------------------------------------------------------- */
function initRegister(form) {
  const errorBox = $('#form-error');
  const submit = $('#register-submit');
  const password = $('#password');
  const meter = $('#password-meter');

  password.addEventListener('input', () => {
    const feedback = passwordFeedback(password.value);
    meter.textContent = feedback.text;
    meter.style.color = feedback.ok ? 'var(--pos-700)' : 'var(--ink-500)';
  });

  // Opening the CNIC section makes consent meaningful, so surface the exact
  // purpose text the platform has configured rather than generic reassurance.
  api.get('/api/public/config').then((config) => {
    document.querySelectorAll('[data-platform-name]').forEach((n) => { n.textContent = config.platformName; });
  }).catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideFormError(errorBox);
    clearFieldErrors(form);

    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
      full_name: data.full_name || '',
      email: data.email || '',
      phone: data.phone || '',
      password: data.password || '',
      confirm_password: data.confirm_password || '',
      accept_terms: form.accept_terms.checked,
      accept_risk: form.accept_risk.checked,
    };
    if (data.cnic) {
      payload.cnic = data.cnic;
      payload.cnic_consent = form.cnic_consent.checked;
    }

    const restore = busy(submit, 'Creating your account…');
    try {
      payload.device = await deviceSignal();
      const result = await api.post('/api/auth/register', payload);
      // The development code is only ever present with no SMS provider wired
      // up; in production this is null and nothing is shown.
      if (result.verification?.developmentCode) {
        sessionStorage.setItem('fxp_dev_otp', result.verification.developmentCode);
      }
      window.location.href = '/app/#/verify';
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields) {
        if (!applyFieldErrors(form, error.fields)) showFormError(errorBox, error.message);
      } else {
        showFormError(errorBox, error.message || 'Your account could not be created. Please try again.');
      }
    }
  });
}

/* -- Sign in -------------------------------------------------------------- */
function initLogin(form) {
  const errorBox = $('#form-error');
  const submit = $('#login-submit');

  api.get('/api/public/config').then((config) => {
    document.querySelectorAll('[data-platform-name]').forEach((n) => { n.textContent = config.platformName; });
    const link = $('#support-link');
    if (link && config.support?.whatsappDigits) {
      link.href = `https://wa.me/${config.support.whatsappDigits}?text=${encodeURIComponent('Hello, I need help signing in to my account.')}`;
      link.target = '_blank';
      link.rel = 'noopener';
    }
  }).catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideFormError(errorBox);
    clearFieldErrors(form);

    const data = Object.fromEntries(new FormData(form).entries());
    const restore = busy(submit, 'Signing in…');
    try {
      const result = await api.post('/api/auth/login', {
        identifier: data.identifier || '',
        password: data.password || '',
        device: await deviceSignal(),
      });
      window.location.href = result.next === 'verify' ? '/app/#/verify' : '/app/';
    } catch (error) {
      restore();
      if (error instanceof ApiError && error.fields) {
        if (!applyFieldErrors(form, error.fields)) showFormError(errorBox, error.message);
      } else {
        showFormError(errorBox, error.message || 'Could not sign you in. Please try again.');
      }
    }
  });
}

const registerForm = document.getElementById('register-form');
const loginForm = document.getElementById('login-form');
if (registerForm) initRegister(registerForm);
if (loginForm) initLogin(loginForm);
