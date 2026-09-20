# Forex investment platform

A forex investment account platform: user registration with phone
verification, an admin-verified deposit workflow, a reviewed withdrawal
workflow, a ledger-backed balance model, and a role-based administrator
console.

> **Brand and copy are placeholders.** The platform is named "Meridian FX" in
> the seeded settings. Change `platform_name` and the content blocks in the
> admin console — they are database values, not code.

---

## What this is, and what it is careful not to claim

The brief behind this build asked for an investment programme with an
example return model. Two things follow from that, and they shape the whole
application:

**Illustrative figures are never presented as returns.** The calculator
applies a fixed arithmetic model chosen by the operator — the amount divided
by a configurable divisor, applied across a configurable number of market
days. The default (30, 24) reproduces the requested example exactly:

| Investment | Example daily | Example 24-day |
|-----------:|--------------:|---------------:|
| $30        | $1.00         | $24.00         |
| $50        | $1.67         | $40.00         |
| $100       | $3.33         | $80.00         |
| $500       | $16.67        | $400.00        |
| $1,000     | $33.33        | $800.00        |
| $2,000     | $66.67        | $1,600.00      |
| $5,000     | $166.67       | $4,000.00      |
| $10,000    | $333.33       | $8,000.00      |

That table is *generated* from the model at runtime, so it cannot drift from
the calculator. The figures are labelled illustrative everywhere they appear,
they are never added to a balance, and nothing schedules them for payment.
Realised profit is a separate ledger entry, posted by a member of staff with
the `ledger.adjust` permission and a permanent audit record.

The words "guaranteed profit", "risk-free", "fixed forex income",
"guaranteed daily return" and "no loss" appear nowhere in the product.

**A screenshot is not a payment.** Submitting a deposit records a *claim*. The
balance moves only when a reviewer with `deposits.review` confirms the payment
against the receiving account records — and the UI makes them tick an
attestation saying exactly that before it will credit anything.

---

## Running it

```bash
npm install
cp .env.example .env        # then fill in the secrets
npm start                   # http://localhost:4000
```

The schema and its reference data are applied on boot; it is idempotent and
never overwrites a value an operator has edited. Set
`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` to have the first
Super Admin created on the first run. That account starts with
`must_change_password`, so the bootstrap password cannot be used for anything
except setting a real one.

```bash
npm test                    # 52 tests, no network or fixtures required
```

In development with no SMS provider configured, the OTP is printed to the
server log and surfaced in the verification screen, because otherwise the flow
could not be completed. In production the server refuses to start a
registration at all when no provider is configured, rather than issuing a code
that cannot reach anyone.

### Surfaces

| Path      | What it is |
|-----------|------------|
| `/`       | Public site: hero, calculator, how it works, risk disclosure |
| `/legal.html` | Risk disclosure, terms, privacy, programme terms |
| `/register.html`, `/login.html` | Account sign-up and sign-in |
| `/app/`   | Account application (dashboard, deposits, withdrawals, …) |
| `/admin/` | Administrator console |
| `/healthz`| Liveness probe |

---

## How the money model works

**There is no `balance` column anywhere.** Every figure is a sum over the
append-only `transactions` ledger. Database triggers block deleting a ledger
row or changing its amount, user, direction, type or bucket. A mistake is
corrected by posting a reversing entry, never by editing history.

Two buckets exist per account:

- `available` — spendable cash
- `invested` — principal committed to an open investment

The flows:

| Event | Ledger effect |
|---|---|
| Deposit verified | credit `available` |
| Investment opened | debit `available`, credit `invested` (total unchanged) |
| Withdrawal requested | debit `available` — a hold, taken immediately |
| Withdrawal rejected or cancelled | mirror entry releases the hold |
| Withdrawal completed | hold released, settlement debit posted |
| Realised profit / correction | credit or debit `available`, referencing its audit record |

A reversal posts the mirror image of the original and marks the original
`reversed`. **Balance aggregates count both rows.** Excluding the original as
well would undo the movement twice — that was a genuine bug during the build,
caught by a test that reconciles the ledger against the derived balance, and
the test remains as a guard.

The withdrawal hold is taken inside the same `IMMEDIATE` transaction that
reads the available balance, so two concurrent requests cannot both pass the
sufficiency check.

---

## Security

| Concern | How it is handled |
|---|---|
| Passwords | bcrypt, cost 12. Swappable for Argon2id — see the note in `src/lib/password.js`. |
| Sessions | Server-side. The cookie carries an opaque random token; only its SHA-256 digest is stored, so a database read cannot be replayed as a login. HttpOnly, SameSite=Lax, Secure in production, absolute expiry plus idle timeout. |
| CSRF | Double-submit. The non-HttpOnly cookie must be echoed in `X-CSRF-Token`; a cross-origin page cannot read it. Required on every non-GET route. |
| Brute force | Per-IP and per-identifier rate limits, plus account lockout after repeated failures. Sign-in returns one message for every failure mode, so it cannot be used to enumerate accounts. |
| OTP | Cryptographically uniform digits, stored only as an HMAC digest, short expiry, capped attempts, resend cooldown, hourly caps per number and per IP. |
| Input | Every route declares the exact fields it accepts; unknown keys are dropped, so a client cannot smuggle in `status`, `balance` or `public_id`. |
| SQL | Parameterised throughout. No user value is ever interpolated into SQL text. |
| XSS | Content is set with `textContent`, never `innerHTML`, and the CSP forbids inline script entirely. Operator-edited copy goes through a restricted Markdown renderer that only produces text nodes. |
| Uploads | Validated by magic bytes, not by filename or the client's Content-Type. Screened for embedded markup (the polyglot trick). Renamed server-side, written `0600` outside the web root, served only through an ownership/permission check with `nosniff` and a sandboxing CSP. |
| Identity data | AES-256-GCM at rest. Masked (`42101-*******-3`) in every view. Revealing the full number needs a separate `kyc.reveal` permission and writes an audit record every time. Retention date recorded on each record. |
| Authorisation | 23 permissions across 4 roles, checked server-side on every route. The console hides controls a role lacks, but that is a courtesy — the server is the gate. |
| Audit | `audit_logs` is append-only, enforced by triggers. No role, Super Admin included, can edit or delete an entry. |

Never trusted from the client: balance, deposit status, profit, permissions,
withdrawal eligibility, admin permissions. All of it is computed server-side.

### Known limits — read before going live

- **Rate limiting is in-process.** Correct for the single-instance default.
  Behind more than one Node process the counters are per-process and the
  effective limit multiplies. Move the store in `src/lib/ratelimit.js` to
  Redis before scaling out.
- **No malware scanner is wired up.** Uploads are type- and content-screened
  but not scanned. `src/middleware/upload.js` exposes `setScanHook` for
  ClamAV or a provider API; until one is set, files are recorded as
  `not_scanned` and the console says so on the review screen rather than
  implying they were checked.
- **No SMS or email provider is implemented.** Adapters are stubbed with a
  clear throw. Every delivery attempt is recorded with its real outcome,
  including `skipped_not_configured` — nothing fakes a send.
- **Payment-provider reconciliation is manual.** There is no EasyPaisa API
  integration; verification is a human matching the reference against the
  receiving account. The data model has the fields an automated
  reconciliation would need (`provider_txn_ref`, `paid_at`, `sender_account`)
  and the review endpoint is the place to add it.
- **SQLite.** Genuinely relational, with foreign keys, constraints, indexes,
  triggers and immediate transactions, and WAL plus `synchronous=FULL` for
  durability. It suits a single instance well. For multiple app servers,
  migrate to PostgreSQL: the schema is standard apart from the SQLite-specific
  `datetime('now', ...)` calls and the trigger syntax.
- **Device fingerprinting is indicative, not conclusive.** It collides between
  different people on similar setups and changes for the same person. It
  raises a case for a human; it never bans anyone by itself. The console says
  this on the screen, so nobody using it forgets.

---

## Configuration, not code

Everything an operator needs to change lives in the database and is editable
in the console: minimum and maximum investment, the illustrative model
parameters, deposit and withdrawal rules, payment methods and receiving
account numbers, support contacts and hours, homepage copy, the risk
disclosure and the legal documents, notification toggles, registration and
maintenance switches.

Two guarantees around that:

- Setting changes are validated server-side — a divisor of zero, an invalid
  phone number, a minimum above the maximum, or enabling a deposit method with
  no receiving account are all refused.
- Every change writes an audit record with the previous value, the new value,
  the administrator and the reason, plus a row in `setting_history`. An
  administrator cannot silently alter historical financial records at all:
  deposits and withdrawals are decided through a state machine, and
  corrections are new ledger entries.

---

## Roles

| Role | Scope |
|---|---|
| Super Admin | Everything, including administrator and role management |
| Finance Admin | Deposits, withdrawals, ledger adjustments, reconciliation |
| Support Admin | Users and support tickets; read-only on anything financial |
| Verification Admin | KYC, deposit verification, duplicate-account review |

A Finance Admin cannot ban a user or reveal an identity document. A Support
Admin cannot decide a deposit or touch the ledger. The last active Super Admin
cannot be disabled. All of this is covered by tests.

---

## Operating it

**Backups.** Back up `DB_PATH` (with its `-wal` and `-shm` files, or via
`sqlite3 .backup`) and `UPLOAD_DIR`. Store `FIELD_ENCRYPTION_KEY` somewhere
separate from the database backup — together they are equivalent to plaintext
identity documents; apart, a leaked backup yields nothing.

**Error monitoring.** `src/middleware/common.js` has the single place where
5xx errors surface; forward from there to Sentry or equivalent.

**Deployment.** `nginx.conf.example` and `ecosystem.config.js` are working
starting points. TLS terminates at the proxy; set `TRUST_PROXY` so the audit
log and the rate limiter see real client addresses. Note that there is
deliberately no `location /uploads` block — uploaded files must only ever be
reached through the access-controlled routes.

---

## Layout

```
server.js               app wiring, security headers, maintenance mode
src/
  config.js             environment, secrets, production guards
  db/
    schema.sql          29 tables, indexes, constraints, triggers, balance view
    reference.js        permissions, roles, settings, legal copy, payment methods
    migrate.js          idempotent migration and first-admin bootstrap
  lib/                  money, ledger, audit, otp, crypto, risk, validation…
  middleware/           sessions, CSRF, auth, RBAC, uploads, rate limiting
  routes/               public, auth, account, deposits, withdrawals, admin/*
public/
  index.html            public site
  app/                  account application
  admin/                administrator console
  assets/               design tokens, components, charts, shared modules
test/                   52 end-to-end tests over the real HTTP surface
```
