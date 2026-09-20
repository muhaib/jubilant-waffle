'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, Client, pngForm } = require('./helpers');

isolate('security');

const app = require('../server');
const { db } = require('../src/db');
const config = require('../src/config');
const { keyedDigest } = require('../src/lib/crypto');
const rateLimit = require('../src/lib/ratelimit');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function otpFor(phone) {
  const row = db.prepare(
    `SELECT * FROM phone_verifications WHERE phone_e164 = ? AND consumed_at IS NULL AND invalidated_at IS NULL
     ORDER BY id DESC LIMIT 1`
  ).get(phone);
  for (let i = 0; i < 10000; i += 1) {
    const c = String(i).padStart(config.otp.length, '0');
    if (keyedDigest(`${phone}|signup|${c}`, config.secrets.otp) === row.code_digest) return c;
  }
  throw new Error('no code');
}

async function makeUser(email, phone, extra = {}) {
  // The suite drives far more registrations from one address than a real
  // visitor ever would; clearing the counters keeps the limiter's own tests
  // meaningful rather than letting setup trip them.
  rateLimit.clearAll();
  const client = new Client(base);
  const registered = await client.post('/api/auth/register', {
    full_name: 'Test User', email, phone,
    password: 'Str0ngPassphrase!', confirm_password: 'Str0ngPassphrase!',
    accept_terms: true, accept_risk: true, ...extra,
  });
  assert.equal(registered.status, 201, `registration failed: ${JSON.stringify(registered.body)}`);
  rateLimit.clearAll();
  const e164 = `+92${phone.replace(/^0/, '')}`;
  await client.post('/api/auth/verify/confirm', { code: otpFor(e164) });
  return client;
}

async function signInAdmin(email, password) {
  rateLimit.clearAll();
  const client = new Client(base);
  const res = await client.post('/api/admin/auth/login', { email, password });
  assert.equal(res.status, 200, `admin sign-in failed: ${JSON.stringify(res.body)}`);
  return client;
}

/* -- Session, CSRF and transport ----------------------------------------- */
test('the session cookie is HttpOnly and SameSite, and the CSRF cookie is not HttpOnly', async () => {
  const client = new Client(base);
  const res = await client.request('POST', '/api/auth/register', {
    json: {
      full_name: 'Cookie Check', email: 'cookie@example.test', phone: '03001110001',
      password: 'Str0ngPassphrase!', confirm_password: 'Str0ngPassphrase!',
      accept_terms: true, accept_risk: true,
    },
  });
  assert.equal(res.status, 201);
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('fxp_sid='));
  const csrf = cookies.find((c) => c.startsWith('fxp_csrf='));
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Lax/i);
  assert.match(session, /Path=\//i);
  // The CSRF half of the double-submit pair must be readable by our own script.
  assert.doesNotMatch(csrf, /HttpOnly/i);
});

test('a state-changing request without the CSRF header is refused', async () => {
  const user = await makeUser('csrf@example.test', '03001110002');
  // A valid session cookie on its own is not enough: this is exactly the
  // shape of a cross-site form post, which cannot read the CSRF cookie.
  const stripped = await fetch(`${base}/api/support`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: user.cookieHeader() },
    body: JSON.stringify({ subject: 'No token', category: 'other', message: 'This should not be accepted.' }),
  });
  assert.equal(stripped.status, 403);

  // The same request with the header does succeed, so the refusal above is
  // the CSRF check and not some unrelated validation failure.
  const ok = await user.post('/api/support', {
    subject: 'With token', category: 'other', message: 'This one should be accepted.',
  });
  assert.equal(ok.status, 201);
});

test('a forged CSRF token is refused', async () => {
  const user = await makeUser('csrf2@example.test', '03001110003');
  const res = await fetch(`${base}/api/support`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: user.cookieHeader(),
      'x-csrf-token': 'not-the-right-token',
    },
    body: JSON.stringify({ subject: 'Forged', category: 'other', message: 'This should not be accepted.' }),
  });
  assert.equal(res.status, 403);
});

test('security headers are set on every response', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.doesNotMatch(res.headers.get('content-security-policy') || '', /script-src[^;]*unsafe-inline/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-powered-by'), null);
});

/* -- Authentication boundaries ------------------------------------------- */
test('the API never returns a password hash or OTP digest', async () => {
  const user = await makeUser('leak@example.test', '03001110004');
  const me = await user.get('/api/me');
  const serialised = JSON.stringify(me.body);
  assert.doesNotMatch(serialised, /password/i);
  assert.doesNotMatch(serialised, /\$2[aby]\$/);
  assert.doesNotMatch(serialised, /code_digest/);
  // The full phone number is masked for the account holder's own view.
  assert.match(me.body.user.phoneMasked, /•/);
});

test('a user session cannot reach administrator endpoints', async () => {
  const user = await makeUser('notadmin@example.test', '03001110005');
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/audit', '/api/admin/settings']) {
    const res = await user.get(path);
    assert.equal(res.status, 401, `${path} should reject a user session`);
  }
});

test('an administrator session cannot act as a user', async () => {
  const adminClient = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  const res = await adminClient.get('/api/me');
  assert.equal(res.status, 401);
});

test('sign-in does not reveal whether an account exists', async () => {
  const unknown = await new Client(base).post('/api/auth/login', {
    identifier: 'nobody@example.test', password: 'whatever-it-is',
  });
  const known = await new Client(base).post('/api/auth/login', {
    identifier: 'leak@example.test', password: 'the-wrong-password',
  });
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.body.error.message, known.body.error.message);
});

test('repeated failed sign-ins lock the account', async () => {
  rateLimit.clearAll();
  const client = new Client(base);
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await client.post('/api/auth/login', {
      identifier: 'leak@example.test', password: `wrong-${i}`,
    });
  }
  assert.equal(last.status, 429);
  const row = db.prepare('SELECT locked_until FROM users WHERE email_normalized = ?').get('leak@example.test');
  assert.ok(row.locked_until, 'the account should carry a lock expiry');
});

/* -- Access control on records ------------------------------------------- */
test('one user cannot read another user\'s uploaded evidence', async () => {
  const owner = await makeUser('owner@example.test', '03001110006');
  const methods = await owner.get('/api/deposits/methods');
  const method = methods.body.methods.find((m) => m.ready);
  const created = await owner.postForm('/api/deposits', pngForm({
    amount: '100', method_id: method.id, sender_account: '03001110006',
    provider_txn_ref: 'SEC-EVID-0001', paid_at: new Date().toISOString(),
  }));
  assert.equal(created.status, 201);

  const detail = await owner.get(`/api/deposits/${created.body.deposit.ref}`);
  const fileUrl = detail.body.evidence[0].url;
  assert.equal((await owner.get(fileUrl)).status, 200);

  const intruder = await makeUser('intruder2@example.test', '03001110007');
  const stolen = await intruder.get(fileUrl);
  // 404, not 403: a probe must not learn that the id exists.
  assert.equal(stolen.status, 404);

  const anonymous = await new Client(base).get(fileUrl);
  assert.equal(anonymous.status, 401);
});

test('a suspended account keeps read access but cannot transact', async () => {
  const user = await makeUser('suspendme@example.test', '03001110008');
  const publicId = (await user.get('/api/me')).body.user.publicId;

  const adminClient = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  const res = await adminClient.post(`/api/admin/users/${publicId}/status`, {
    action: 'restrict', reason: 'Automated security test restriction.',
  });
  assert.equal(res.status, 200);

  const blocked = await user.post('/api/investments', { amount: '30', acknowledge_risk: true });
  assert.equal(blocked.status, 403);
  // Their own records remain readable.
  assert.equal((await user.get('/api/me')).status, 200);
});

test('suspending an account ends its sessions', async () => {
  const user = await makeUser('killsession@example.test', '03001110009');
  const publicId = (await user.get('/api/me')).body.user.publicId;
  const adminClient = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  await adminClient.post(`/api/admin/users/${publicId}/status`, {
    action: 'suspend', reason: 'Automated security test suspension.',
  });
  const after = await user.get('/api/me');
  assert.equal(after.status, 401);
});

/* -- Role-based authorisation -------------------------------------------- */
test('roles carry only their own permissions, enforced server-side', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');

  const created = await superAdmin.post('/api/admin/admins', {
    name: 'Support Person', email: 'support@example.test',
    role: 'support_admin', password: 'SupportPassword123',
  });
  assert.equal(created.status, 201);

  const support = await signInAdmin('support@example.test', 'SupportPassword123');
  const session = await support.get('/api/admin/auth/session');
  assert.equal(session.body.admin.role, 'support_admin');
  assert.ok(!session.body.admin.permissions.includes('deposits.review'));
  assert.ok(!session.body.admin.permissions.includes('ledger.adjust'));
  assert.ok(session.body.admin.permissions.includes('support.respond'));

  // Reading is allowed; deciding is not.
  assert.equal((await support.get('/api/admin/deposits')).status, 200);

  const anyDeposit = db.prepare('SELECT ref FROM deposits ORDER BY id DESC LIMIT 1').get();
  assert.ok(anyDeposit, 'an earlier test should have created a deposit to act on');
  const decide = await support.post(`/api/admin/deposits/${anyDeposit.ref}/decision`, {
    decision: 'verify', confirm_reconciled: true,
  });
  assert.equal(decide.status, 403);

  const adjust = await support.post('/api/admin/users/USR-000000/adjust', {
    type: 'adjustment_credit', amount: '100', reason: 'Should never be permitted.',
  });
  assert.equal(adjust.status, 403);

  assert.equal((await support.get('/api/admin/audit')).status, 403);
  assert.equal((await support.get('/api/admin/admins')).status, 403);
});

test('a finance admin cannot change user status or reveal identity documents', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  await superAdmin.post('/api/admin/admins', {
    name: 'Finance Person', email: 'finance@example.test',
    role: 'finance_admin', password: 'FinancePassword123',
  });
  const finance = await signInAdmin('finance@example.test', 'FinancePassword123');

  const someone = db.prepare('SELECT public_id FROM users LIMIT 1').get();
  const status = await finance.post(`/api/admin/users/${someone.public_id}/status`, {
    action: 'ban', reason: 'Finance should not be able to do this.',
  });
  assert.equal(status.status, 403);

  const reveal = await finance.post(`/api/admin/users/${someone.public_id}/kyc/reveal`, {
    reason: 'Finance should not be able to do this.',
  });
  assert.equal(reveal.status, 403);

  // What finance is for does work.
  assert.equal((await finance.get('/api/admin/withdrawals')).status, 200);
  assert.equal((await finance.get('/api/admin/ledger')).status, 200);
});

test('the last active Super Admin cannot be disabled', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  const list = await superAdmin.get('/api/admin/admins');
  const supers = list.body.items.filter((a) => a.role === 'super_admin');
  assert.equal(supers.length, 1, 'this fixture has exactly one Super Admin');

  // Disabling yourself is refused outright, which also covers the
  // last-Super-Admin case here.
  const self = list.body.items.find((a) => a.isSelf);
  const res = await superAdmin.post(`/api/admin/admins/${self.publicId}/status`, {
    status: 'disabled', reason: 'Should be refused.',
  });
  assert.equal(res.status, 400);

  // A second Super Admin may be disabled, but the final one may not.
  await superAdmin.post('/api/admin/admins', {
    name: 'Second Super', email: 'super2@example.test',
    role: 'super_admin', password: 'SecondSuperPass123',
  });
  const refreshed = await superAdmin.get('/api/admin/admins');
  const second = refreshed.body.items.find((a) => a.email === 'super2@example.test');
  const disabled = await superAdmin.post(`/api/admin/admins/${second.publicId}/status`, {
    status: 'disabled', reason: 'No longer required.',
  });
  assert.equal(disabled.status, 200);
});

/* -- Identity data -------------------------------------------------------- */
test('an identity document is stored encrypted, masked in responses and audited on reveal', async () => {
  const user = await makeUser('kyc@example.test', '03001110010');
  const publicId = (await user.get('/api/me')).body.user.publicId;

  const form = new FormData();
  form.append('cnic', '4210112345673');
  form.append('full_name_on_id', 'Test User');
  form.append('consent', 'true');
  const submitted = await user.postForm('/api/kyc', form);
  assert.equal(submitted.status, 201);

  // Nothing in the database holds the plaintext.
  const row = db.prepare('SELECT * FROM kyc_records WHERE user_id = (SELECT id FROM users WHERE public_id = ?)').get(publicId);
  assert.doesNotMatch(row.id_ciphertext, /4210112345673/);
  assert.match(row.id_ciphertext, /^v1\./);
  assert.equal(row.id_prefix, '42101');
  assert.equal(row.id_last, '3');

  const own = await user.get('/api/kyc');
  assert.equal(own.body.record.masked, '42101-*******-3');
  assert.doesNotMatch(JSON.stringify(own.body), /4210112345673/);

  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  const view = await superAdmin.get(`/api/admin/users/${publicId}`);
  assert.equal(view.body.kyc.masked, '42101-*******-3');
  assert.doesNotMatch(JSON.stringify(view.body), /4210112345673/);

  const before = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'kyc.revealed'`).get().c;
  const revealed = await superAdmin.post(`/api/admin/users/${publicId}/kyc/reveal`, {
    reason: 'Reconciling a payment where the sender name does not match.',
  });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.value, '42101-1234567-3');
  const after = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'kyc.revealed'`).get().c;
  assert.equal(after, before + 1, 'every reveal must be audited');
});

/* -- Injection and input handling ---------------------------------------- */
test('search input is parameterised, not interpolated', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  const before = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const res = await superAdmin.get(`/api/admin/users?q=${encodeURIComponent("'; DROP TABLE users; --")}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 0);
  const after = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  assert.equal(after, before, 'the users table must still exist with the same rows');
});

test('a client cannot set fields the route did not ask for', async () => {
  const user = await makeUser('massassign@example.test', '03001110011');
  const res = await user.patch('/api/me/profile', {
    city: 'Karachi',
    status: 'normal',
    public_id: 'USR-HACKED',
    password_hash: 'anything',
  });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT public_id, status FROM users WHERE email_normalized = ?').get('massassign@example.test');
  assert.notEqual(row.public_id, 'USR-HACKED');
});

/* -- Configuration drives behaviour -------------------------------------- */
test('changing the investment minimum takes effect immediately', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  const before = await new Client(base).get('/api/public/config');
  assert.equal(before.body.investment.minCents, 3000);

  const updated = await superAdmin.put('/api/admin/settings', {
    key: 'min_investment_cents', value: '75', reason: 'Automated test.',
  });
  assert.equal(updated.status, 200);

  const after = await new Client(base).get('/api/public/config');
  assert.equal(after.body.investment.minCents, 7500);

  const table = await new Client(base).get('/api/public/illustration-table');
  assert.ok(table.body.rows.every((r) => r.principalCents >= 7500));

  // Restore for later tests.
  await superAdmin.put('/api/admin/settings', {
    key: 'min_investment_cents', value: '30', reason: 'Automated test restore.',
  });
});

test('changing the illustrative model changes the calculator and the table together', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  await superAdmin.put('/api/admin/settings', { key: 'illus_divisor', value: '60', reason: 'Automated test.' });

  const calc = await new Client(base).post('/api/public/calculator', { amount: '60' });
  assert.equal(calc.body.illustrative.dailyCents, 100);
  const table = await new Client(base).get('/api/public/illustration-table');
  assert.equal(table.body.model.divisor, 60);
  assert.equal(table.body.rows[0].dailyCents, Math.round(table.body.rows[0].principalCents / 60));

  await superAdmin.put('/api/admin/settings', { key: 'illus_divisor', value: '30', reason: 'Automated test restore.' });
});

test('a setting change writes an audit record with the old and the new value', async () => {
  const entry = db.prepare(
    `SELECT * FROM audit_logs WHERE action = 'settings.changed' ORDER BY id DESC LIMIT 1`
  ).get();
  assert.ok(entry, 'a settings change should be audited');
  assert.ok(entry.previous_value);
  assert.ok(entry.new_value);
  assert.ok(entry.actor_label.startsWith('ADM-'));
  const history = db.prepare('SELECT COUNT(*) AS c FROM setting_history').get().c;
  assert.ok(history > 0);
});

test('an invalid setting value is refused', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  assert.equal((await superAdmin.put('/api/admin/settings', {
    key: 'illus_divisor', value: '0', reason: 'Should be refused.',
  })).status, 422);
  assert.equal((await superAdmin.put('/api/admin/settings', {
    key: 'support_whatsapp', value: 'not a phone number', reason: 'Should be refused.',
  })).status, 422);
  assert.equal((await superAdmin.put('/api/admin/settings', {
    key: 'min_investment_cents', value: '99999999', reason: 'Above the maximum.',
  })).status, 422);
});

test('maintenance mode closes the platform to users but not to administrators', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  await superAdmin.put('/api/admin/settings', { key: 'maintenance_mode', value: '1', reason: 'Automated test.' });

  const visitor = await new Client(base).get('/api/public/config');
  assert.equal(visitor.status, 503);
  assert.equal(visitor.body.error.code, 'maintenance');

  assert.equal((await superAdmin.get('/api/admin/overview')).status, 200);

  await superAdmin.put('/api/admin/settings', { key: 'maintenance_mode', value: '0', reason: 'Automated test restore.' });
  assert.equal((await new Client(base).get('/api/public/config')).status, 200);
});

test('a payment method cannot be enabled for deposits without a receiving account', async () => {
  const superAdmin = await signInAdmin('root@example.test', 'bootstrap-admin-pass-1');
  const methods = await superAdmin.get('/api/admin/payment-methods');
  const jazz = methods.body.items.find((m) => m.key === 'jazzcash');
  const res = await superAdmin.put(`/api/admin/payment-methods/${jazz.id}`, {
    name: 'JazzCash', account_title: '', account_number: '', instructions: '',
    for_deposit: true, for_withdrawal: true, is_active: true,
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.fields.account_number);
});

/* -- Rate limiting -------------------------------------------------------- */
test('OTP requests are rate limited', async () => {
  rateLimit.clearAll();
  const client = new Client(base);
  await client.post('/api/auth/register', {
    full_name: 'Rate Limited', email: 'rate@example.test', phone: '03001110012',
    password: 'Str0ngPassphrase!', confirm_password: 'Str0ngPassphrase!',
    accept_terms: true, accept_risk: true,
  });
  // The cooldown starts immediately after the code issued at registration.
  const res = await client.post('/api/auth/verify/request', {});
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});
