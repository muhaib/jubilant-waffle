'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Each test file gets a throwaway database and upload directory. */
function isolate(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fxp-${name}-`));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');
  process.env.SESSION_SECRET = 'x'.repeat(40);
  process.env.OTP_SECRET = 'y'.repeat(40);
  process.env.KYC_DIGEST_SECRET = 'z'.repeat(40);
  process.env.FIELD_ENCRYPTION_KEY = 'a1'.repeat(32);
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'root@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'bootstrap-admin-pass-1';
  return dir;
}

/** Minimal cookie-jar HTTP client that mirrors what the browser does. */
class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  get csrf() { return this.cookies.get('fxp_csrf'); }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, url, { json, form, headers = {} } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (this.cookies.size) init.headers.cookie = this.cookieHeader();
    if (this.csrf) init.headers['x-csrf-token'] = this.csrf;
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    if (form) init.body = form;

    const res = await fetch(this.baseUrl + url, init);
    this.absorb(res);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  }

  get(url, opts) { return this.request('GET', url, opts); }
  post(url, json, opts) { return this.request('POST', url, { json, ...opts }); }
  postForm(url, form) { return this.request('POST', url, { form }); }
  put(url, json) { return this.request('PUT', url, { json }); }
  patch(url, json) { return this.request('PATCH', url, { json }); }
  del(url) { return this.request('DELETE', url); }
}

/** A real 1x1 PNG, so magic-byte validation passes on genuine bytes. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function pngForm(fields, fieldName = 'screenshot') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append(fieldName, new Blob([PNG_1PX], { type: 'image/png' }), 'proof.png');
  return form;
}

module.exports = { isolate, Client, PNG_1PX, pngForm };
