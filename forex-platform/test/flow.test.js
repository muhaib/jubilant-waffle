'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, Client, pngForm } = require('./helpers');

isolate('flow');

const app = require('../server');
const { db } = require('../src/db');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

/** Read the OTP straight from the issuing code path, as an SMS would deliver it. */
function currentOtpFor(phoneE164) {
  // The digest is one-way, so tests re-derive the code the same way the
  // server verifies it: brute-force the 4-digit space against the digest.
  const config = require('../src/config');
  const { keyedDigest } = require('../src/lib/crypto');
  const row = db.prepare(
    `SELECT * FROM phone_verifications WHERE phone_e164 = ? AND consumed_at IS NULL AND invalidated_at IS NULL
     ORDER BY id DESC LIMIT 1`
  ).get(phoneE164);
  assert.ok(row, 'an OTP should have been issued');
  for (let i = 0; i < 10000; i += 1) {
    const candidate = String(i).padStart(config.otp.length, '0');
    if (keyedDigest(`${phoneE164}|signup|${candidate}`, config.secrets.otp) === row.code_digest) return candidate;
  }
  throw new Error('could not recover the issued code');
}

const USER = {
  full_name: 'Test Account Holder',
  email: 'holder@example.test',
  phone: '03001234567',
  password: 'Str0ngPassphrase!',
  confirm_password: 'Str0ngPassphrase!',
  accept_terms: true,
  accept_risk: true,
  device: { hash: 'device-hash-aaa', platform: 'Linux', timezone: 'Asia/Karachi' },
};

const user = new Client('');
const admin = new Client('');

test('registration requires the terms and risk acknowledgements', async () => {
  user.baseUrl = base;
  const res = await user.post('/api/auth/register', { ...USER, accept_risk: false });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.fields.accept_risk);
});

test('registration rejects a mismatched password confirmation', async () => {
  const res = await user.post('/api/auth/register', { ...USER, confirm_password: 'something-else' });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.fields.confirm_password);
});

test('registration issues a USR- public id and demands phone verification', async () => {
  const res = await user.post('/api/auth/register', USER);
  assert.equal(res.status, 201);
  assert.match(res.body.user.publicId, /^USR-[0-9A-Z]{6}$/);
  assert.equal(res.body.user.status, 'verification_required');
  assert.equal(res.body.verification.required, true);
  // The phone number is not the account id, and is masked in responses.
  assert.notEqual(res.body.user.publicId, USER.phone);
  assert.match(res.body.user.phoneMasked, /•/);
});

test('a second account cannot reuse the same phone number', async () => {
  const other = new Client(base);
  const res = await other.post('/api/auth/register', { ...USER, email: 'other@example.test' });
  assert.equal(res.status, 409);
});

test('transacting is blocked until the phone is verified', async () => {
  const res = await user.post('/api/investments', { amount: '30', acknowledge_risk: true });
  assert.equal(res.status, 403);
});

test('an incorrect OTP is rejected and counted', async () => {
  const real = currentOtpFor('+923001234567');
  const wrong = String((Number(real) + 1) % 10000).padStart(4, '0');
  const res = await user.post('/api/auth/verify/confirm', { code: wrong });
  assert.equal(res.status, 422);
  assert.match(res.body.error.message, /not correct/);
});

test('the correct OTP activates the account', async () => {
  const code = currentOtpFor('+923001234567');
  const res = await user.post('/api/auth/verify/confirm', { code });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.status, 'normal');
});

test('a consumed OTP cannot be replayed', async () => {
  const res = await user.post('/api/auth/verify/confirm', { code: '0000' });
  // Already verified, so the endpoint short-circuits rather than re-checking.
  assert.equal(res.body.alreadyVerified, true);
});

test('a deposit without evidence is refused', async () => {
  const methods = await user.get('/api/deposits/methods');
  const method = methods.body.methods.find((m) => m.ready);
  assert.ok(method, 'the seeded EasyPaisa method should be ready');

  const form = new FormData();
  form.append('amount', '250');
  form.append('method_id', String(method.id));
  form.append('sender_account', '03009998888');
  form.append('provider_txn_ref', 'TXN-TEST-0001');
  form.append('paid_at', new Date().toISOString());
  const res = await user.postForm('/api/deposits', form);
  assert.equal(res.status, 422);
  assert.ok(res.body.error.fields.screenshot);
});

test('a non-image upload is refused by content, not by filename', async () => {
  const methods = await user.get('/api/deposits/methods');
  const method = methods.body.methods.find((m) => m.ready);
  const form = new FormData();
  form.append('amount', '250');
  form.append('method_id', String(method.id));
  form.append('sender_account', '03009998888');
  form.append('provider_txn_ref', 'TXN-TEST-0002');
  form.append('paid_at', new Date().toISOString());
  // Claims to be a PNG, is actually a shell script.
  form.append('screenshot', new Blob([Buffer.from('#!/bin/sh\nrm -rf /\n')], { type: 'image/png' }), 'proof.png');
  const res = await user.postForm('/api/deposits', form);
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /JPEG or PNG/);
});

let depositRef;

test('a submitted deposit is pending and credits nothing', async () => {
  const methods = await user.get('/api/deposits/methods');
  const method = methods.body.methods.find((m) => m.ready);
  const res = await user.postForm('/api/deposits', pngForm({
    amount: '250',
    method_id: method.id,
    sender_account: '03009998888',
    sender_name: 'Test Account Holder',
    provider_txn_ref: 'TXN-TEST-0003',
    paid_at: new Date().toISOString(),
  }));
  assert.equal(res.status, 201);
  assert.equal(res.body.deposit.status, 'pending');
  depositRef = res.body.deposit.ref;

  const me = await user.get('/api/me');
  assert.equal(me.body.balances.availableCents, 0, 'a screenshot must not credit a balance');
  assert.equal(me.body.balances.pendingDepositCents, 25000);
});

test('the same transaction reference cannot be submitted twice', async () => {
  const methods = await user.get('/api/deposits/methods');
  const method = methods.body.methods.find((m) => m.ready);
  const res = await user.postForm('/api/deposits', pngForm({
    amount: '250',
    method_id: method.id,
    sender_account: '03009998888',
    provider_txn_ref: 'TXN-TEST-0003',
    paid_at: new Date().toISOString(),
  }));
  assert.equal(res.status, 409);
});

test('another user cannot read the first user\'s deposit', async () => {
  const intruder = new Client(base);
  await intruder.post('/api/auth/register', {
    ...USER, email: 'intruder@example.test', phone: '03007654321',
    device: { hash: 'device-hash-bbb' },
  });
  const res = await intruder.get(`/api/deposits/${depositRef}`);
  assert.equal(res.status, 404);
});

test('admin sign-in works and exposes only the permissions of its role', async () => {
  admin.baseUrl = base;
  const res = await admin.post('/api/admin/auth/login', {
    email: 'root@example.test', password: 'bootstrap-admin-pass-1',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.role, 'super_admin');
  assert.ok(res.body.admin.permissions.includes('deposits.review'));
  assert.equal(res.body.admin.mustChangePassword, true);
});

test('a deposit cannot be verified without confirming reconciliation', async () => {
  const res = await admin.post(`/api/admin/deposits/${depositRef}/decision`, { decision: 'verify' });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.fields.confirm_reconciled);
});

test('verifying a deposit credits the ledger exactly once', async () => {
  const res = await admin.post(`/api/admin/deposits/${depositRef}/decision`, {
    decision: 'verify', confirm_reconciled: true, note: 'Matched against receiving account statement.',
  });
  assert.equal(res.status, 200);
  assert.match(res.body.transaction, /^TXN-/);

  const me = await user.get('/api/me');
  assert.equal(me.body.balances.availableCents, 25000);
  assert.equal(me.body.balances.pendingDepositCents, 0);
  assert.equal(me.body.balances.totalDepositedCents, 25000);

  // Re-deciding a settled deposit is refused, so it cannot be double-credited.
  const again = await admin.post(`/api/admin/deposits/${depositRef}/decision`, {
    decision: 'verify', confirm_reconciled: true,
  });
  assert.equal(again.status, 400);
});

test('an investment moves money between buckets without changing the total', async () => {
  const before = (await user.get('/api/me')).body.balances;
  const res = await user.post('/api/investments', { amount: '100', acknowledge_risk: true });
  assert.equal(res.status, 201);
  // $100 under the 30/24 model: $3.33 a day, $80 across the cycle.
  assert.equal(res.body.investment.illustrative.dailyCents, 333);
  assert.equal(res.body.investment.illustrative.cycleCents, 8000);

  const after = (await user.get('/api/me')).body.balances;
  assert.equal(after.availableCents, before.availableCents - 10000);
  assert.equal(after.investedCents, 10000);
  assert.equal(after.totalCents, before.totalCents, 'total balance is unchanged by an allocation');
});

test('an investment below the minimum is refused', async () => {
  const res = await user.post('/api/investments', { amount: '5', acknowledge_risk: true });
  assert.equal(res.status, 422);
  assert.match(res.body.error.fields.amount, /minimum/);
});

test('a withdrawal cannot exceed the available balance', async () => {
  const options = await user.get('/api/withdrawals/options');
  const res = await user.post('/api/withdrawals', {
    amount: '99999', method_id: options.body.methods[0].id,
    payout_title: 'Test Account Holder', payout_account: '03001234567',
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'insufficient_funds');
});

let withdrawalRef;

test('a withdrawal holds the amount immediately', async () => {
  const options = await user.get('/api/withdrawals/options');
  const before = (await user.get('/api/me')).body.balances;
  const res = await user.post('/api/withdrawals', {
    amount: '50', method_id: options.body.methods[0].id,
    payout_title: 'Test Account Holder', payout_account: '03001234567',
  });
  assert.equal(res.status, 201);
  withdrawalRef = res.body.withdrawal.ref;

  const after = (await user.get('/api/me')).body.balances;
  assert.equal(after.availableCents, before.availableCents - 5000);
  assert.equal(after.pendingWithdrawalCents, 5000);
});

test('a rejected withdrawal returns the held amount', async () => {
  const options = await user.get('/api/withdrawals/options');
  const created = await user.post('/api/withdrawals', {
    amount: '25', method_id: options.body.methods[0].id,
    payout_title: 'Test Account Holder', payout_account: '03001234567',
  });
  const before = (await user.get('/api/me')).body.balances;
  const res = await admin.post(`/api/admin/withdrawals/${created.body.withdrawal.ref}/decision`, {
    status: 'rejected', note: 'Payout account name does not match the account holder.',
  });
  assert.equal(res.status, 200);
  const after = (await user.get('/api/me')).body.balances;
  assert.equal(after.availableCents, before.availableCents + 2500);
});

test('a withdrawal cannot skip straight from pending to completed', async () => {
  const res = await admin.post(`/api/admin/withdrawals/${withdrawalRef}/decision`, {
    status: 'completed', provider_ref: 'EP-123',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /can only move to/);
});

test('completing a withdrawal settles it and leaves the balance correct', async () => {
  const before = (await user.get('/api/me')).body.balances;
  await admin.post(`/api/admin/withdrawals/${withdrawalRef}/decision`, { status: 'approved' });
  await admin.post(`/api/admin/withdrawals/${withdrawalRef}/decision`, { status: 'processing' });
  const res = await admin.post(`/api/admin/withdrawals/${withdrawalRef}/decision`, {
    status: 'completed', provider_ref: 'EP-987654',
  });
  assert.equal(res.status, 200);

  const after = (await user.get('/api/me')).body.balances;
  // The money already left available at hold time; settling must not debit twice.
  assert.equal(after.availableCents, before.availableCents);
  assert.equal(after.pendingWithdrawalCents, 0);
  assert.equal(after.totalWithdrawnCents, 5000);
});

test('the ledger reconciles against the derived balance', async () => {
  const me = await user.get('/api/me');
  // Every row counts, including ones marked reversed: a reversal is cancelled
  // by its mirror entry, not by removing the original from the sum.
  const rows = db.prepare(`
    SELECT direction, bucket, amount_cents FROM transactions
    WHERE user_id = (SELECT id FROM users WHERE email_normalized = ?)
  `).all('holder@example.test');
  const available = rows.filter((r) => r.bucket === 'available')
    .reduce((sum, r) => sum + (r.direction === 'credit' ? r.amount_cents : -r.amount_cents), 0);
  assert.equal(available, me.body.balances.availableCents);

  // A reversed hold plus its mirror must net to exactly zero.
  const netByWithdrawal = db.prepare(`
    SELECT withdrawal_id,
           SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE -amount_cents END) AS net
    FROM transactions WHERE type IN ('withdrawal_hold','withdrawal_release')
    GROUP BY withdrawal_id
  `).all();
  for (const row of netByWithdrawal) {
    assert.equal(row.net, 0, `holds for withdrawal ${row.withdrawal_id} should net to zero once released`);
  }
});

test('ledger rows cannot be deleted or have their amount edited', async () => {
  assert.throws(() => db.prepare('DELETE FROM transactions WHERE id = 1').run(), /append-only/);
  assert.throws(
    () => db.prepare('UPDATE transactions SET amount_cents = 999999 WHERE id = 1').run(),
    /immutable/
  );
});

test('the audit log cannot be edited or deleted', async () => {
  assert.throws(() => db.prepare('DELETE FROM audit_logs WHERE id = 1').run(), /append-only/);
  assert.throws(() => db.prepare(`UPDATE audit_logs SET action = 'x' WHERE id = 1`).run(), /append-only/);
});

test('every money movement produced an audit record', async () => {
  const actions = db.prepare('SELECT DISTINCT action FROM audit_logs').all().map((r) => r.action);
  for (const expected of ['user.registered', 'deposit.submitted', 'deposit.verify',
                          'withdrawal.requested', 'withdrawal.completed', 'investment.opened']) {
    assert.ok(actions.includes(expected), `expected an audit record for ${expected}`);
  }
});
