/*
 * API client.
 *
 * Reads the CSRF value from the readable cookie and echoes it in a header on
 * every state-changing call, which is the half of the double-submit pair the
 * server checks. Errors come back as typed objects so a form can attach
 * per-field messages instead of showing a generic failure.
 */

export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields || null;
  }
  get isValidation() { return this.status === 422 || Boolean(this.fields); }
  get isAuth() { return this.status === 401; }
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)fxp_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function request(method, path, { json, form, signal } = {}) {
  const headers = { accept: 'application/json' };
  const token = csrfToken();
  if (token) headers['x-csrf-token'] = token;

  const init = { method, headers, credentials: 'same-origin', signal };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  if (form) init.body = form;

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return null;
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (!res.ok) {
    const e = body?.error || {};
    throw new ApiError(res.status, e.code || 'error', e.message || 'Something went wrong.', e.fields);
  }
  return body;
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, json, opts) => request('POST', path, { json, ...opts }),
  postForm: (path, form) => request('POST', path, { form }),
  put: (path, json) => request('PUT', path, { json }),
  patch: (path, json) => request('PATCH', path, { json }),
  del: (path) => request('DELETE', path),
};
