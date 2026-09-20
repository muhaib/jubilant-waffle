-- =====================================================================
-- Forex investment platform — relational schema
--
-- Conventions
--   * All money is stored as INTEGER minor units (cents). No floats ever
--     touch a balance. Currency is carried alongside every amount.
--   * Every table carries created_at / updated_at as ISO-8601 UTC text.
--   * Balances are NEVER stored as a mutable column. They are derived
--     from the append-only `transactions` ledger (see v_user_balances).
--   * audit_logs is append-only, enforced by triggers below.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id         TEXT    NOT NULL UNIQUE,              -- e.g. USR-8F4K29
  full_name         TEXT    NOT NULL,
  email             TEXT    NOT NULL,
  email_normalized  TEXT    NOT NULL UNIQUE,
  phone_e164        TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'verification_required'
                      CHECK (status IN ('normal','verification_required','duplicate_suspected',
                                        'under_review','restricted','suspended','banned')),
  status_reason     TEXT,
  phone_verified_at TEXT,
  email_verified_at TEXT,
  terms_accepted_at TEXT    NOT NULL,
  risk_ack_at       TEXT    NOT NULL,
  terms_version     TEXT    NOT NULL,
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  last_login_at     TEXT,
  signup_ip         TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_status  ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth TEXT,
  address_line  TEXT,
  city          TEXT,
  country       TEXT NOT NULL DEFAULT 'PK',
  occupation    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phone OTP. Codes are stored only as HMAC digests, never in plaintext.
CREATE TABLE IF NOT EXISTS phone_verifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  phone_e164   TEXT    NOT NULL,
  purpose      TEXT    NOT NULL CHECK (purpose IN ('signup','login','withdrawal','recovery')),
  code_digest  TEXT    NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at   TEXT    NOT NULL,
  consumed_at  TEXT,
  invalidated_at TEXT,
  request_ip   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON phone_verifications(phone_e164, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_user  ON phone_verifications(user_id, created_at);

-- KYC. The identity number is encrypted at rest (AES-256-GCM) and a separate
-- keyed HMAC is kept purely so duplicate submissions can be detected without
-- decrypting anything. Only the last digit(s) are ever rendered in a UI.
CREATE TABLE IF NOT EXISTS kyc_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type       TEXT    NOT NULL DEFAULT 'cnic',
  id_ciphertext  TEXT    NOT NULL,
  id_digest      TEXT    NOT NULL,
  id_prefix      TEXT    NOT NULL,
  id_last        TEXT    NOT NULL,
  full_name_on_id TEXT,
  front_file_id  INTEGER REFERENCES files(id),
  back_file_id   INTEGER REFERENCES files(id),
  status         TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','under_review','approved','rejected')),
  consent_at     TEXT    NOT NULL,
  consent_version TEXT   NOT NULL,
  purpose_note   TEXT    NOT NULL,
  retention_until TEXT   NOT NULL,
  reviewed_by    INTEGER REFERENCES admin_users(id),
  reviewed_at    TEXT,
  review_note    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kyc_user   ON kyc_records(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_digest ON kyc_records(id_digest);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_records(status);

-- ---------------------------------------------------------------------
-- Device / risk signals
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_hash   TEXT    NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent    TEXT,
  platform      TEXT,
  screen        TEXT,
  timezone      TEXT,
  languages     TEXT,
  first_seen_ip TEXT,
  last_seen_ip  TEXT,
  seen_count    INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_hash, user_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_hash ON devices(device_hash);

CREATE TABLE IF NOT EXISTS risk_flags (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL,       -- duplicate_device | duplicate_kyc | duplicate_payout | velocity
  severity       TEXT    NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  status         TEXT    NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','under_review','confirmed','dismissed')),
  confidence     TEXT    NOT NULL DEFAULT 'indicative',
  signals_json   TEXT    NOT NULL DEFAULT '{}',
  related_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_by    INTEGER REFERENCES admin_users(id),
  resolved_at    TEXT,
  resolution_note TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_riskflags_user   ON risk_flags(user_id);
CREATE INDEX IF NOT EXISTS idx_riskflags_status ON risk_flags(status);

-- ---------------------------------------------------------------------
-- Files (payment evidence, KYC images). Stored outside the web root and
-- only ever served through an access-controlled route.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('deposit_evidence','kyc_front','kyc_back','other')),
  original_name TEXT    NOT NULL,
  stored_name   TEXT    NOT NULL UNIQUE,
  mime          TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,
  scan_status   TEXT    NOT NULL DEFAULT 'not_scanned'
                  CHECK (scan_status IN ('not_scanned','clean','suspect','error')),
  scan_note     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_files_owner  ON files(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_files_sha    ON files(sha256);

-- ---------------------------------------------------------------------
-- Payment configuration (admin-editable, never hard-coded in the UI)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  provider        TEXT    NOT NULL,
  account_title   TEXT,
  account_number  TEXT,
  instructions    TEXT,
  for_deposit     INTEGER NOT NULL DEFAULT 1,
  for_withdrawal  INTEGER NOT NULL DEFAULT 1,
  is_active       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Investments
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ref                 TEXT    NOT NULL UNIQUE,     -- INV-XXXXXX
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  principal_cents     INTEGER NOT NULL CHECK (principal_cents > 0),
  currency            TEXT    NOT NULL DEFAULT 'USD',
  status              TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','closing','closed','cancelled')),
  -- Snapshot of the illustrative model in force when the investment opened.
  -- Kept so a later settings change never rewrites what the user was shown.
  model_divisor       INTEGER NOT NULL,
  model_cycle_days    INTEGER NOT NULL,
  illus_daily_cents   INTEGER NOT NULL,
  illus_cycle_cents   INTEGER NOT NULL,
  opened_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at           TEXT,
  close_note          TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_investments_user ON investments(user_id, status);

-- ---------------------------------------------------------------------
-- Deposits
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposits (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ref              TEXT    NOT NULL UNIQUE,        -- DEP-XXXXXXXX
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  currency         TEXT    NOT NULL DEFAULT 'USD',
  method_id        INTEGER NOT NULL REFERENCES payment_methods(id),
  sender_name      TEXT,
  sender_account   TEXT    NOT NULL,
  provider_txn_ref TEXT    NOT NULL,
  paid_at          TEXT    NOT NULL,
  user_note        TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','under_review','info_requested','verified','rejected','cancelled')),
  reviewed_by      INTEGER REFERENCES admin_users(id),
  reviewed_at      TEXT,
  review_note      TEXT,
  credit_txn_id    INTEGER REFERENCES transactions(id),
  submitted_ip     TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deposits_user   ON deposits(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status, created_at);
CREATE INDEX IF NOT EXISTS idx_deposits_ref    ON deposits(provider_txn_ref);

CREATE TABLE IF NOT EXISTS deposit_evidence (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  deposit_id INTEGER NOT NULL REFERENCES deposits(id) ON DELETE CASCADE,
  file_id    INTEGER NOT NULL REFERENCES files(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (deposit_id, file_id)
);

-- ---------------------------------------------------------------------
-- Withdrawals
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS withdrawals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref            TEXT    NOT NULL UNIQUE,          -- WDR-XXXXXXXX
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents      INTEGER NOT NULL DEFAULT 0,
  net_cents      INTEGER NOT NULL,
  currency       TEXT    NOT NULL DEFAULT 'USD',
  method_id      INTEGER NOT NULL REFERENCES payment_methods(id),
  payout_title   TEXT    NOT NULL,
  payout_account TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','under_review','approved','processing','completed','rejected','cancelled')),
  hold_txn_id    INTEGER REFERENCES transactions(id),
  release_txn_id INTEGER REFERENCES transactions(id),
  reviewed_by    INTEGER REFERENCES admin_users(id),
  reviewed_at    TEXT,
  review_note    TEXT,
  processed_at   TEXT,
  provider_ref   TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user   ON withdrawals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, created_at);

-- ---------------------------------------------------------------------
-- Financial ledger. Append-only in practice: a posted row is never edited,
-- it is reversed by a second row that points back at it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_ref        TEXT    NOT NULL UNIQUE,          -- TXN-XXXXXXXXXX
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL CHECK (type IN (
                    'deposit_credit','withdrawal_hold','withdrawal_release','withdrawal_settle',
                    'investment_allocation','investment_principal_return','profit_credit',
                    'adjustment_credit','adjustment_debit','fee_debit')),
  direction      TEXT    NOT NULL CHECK (direction IN ('credit','debit')),
  -- which balance bucket the row moves: available cash, or locked principal
  bucket         TEXT    NOT NULL DEFAULT 'available' CHECK (bucket IN ('available','invested')),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  currency       TEXT    NOT NULL DEFAULT 'USD',
  source         TEXT    NOT NULL,                 -- deposit | withdrawal | investment | admin | system
  status         TEXT    NOT NULL DEFAULT 'posted'
                   CHECK (status IN ('posted','reversed')),
  deposit_id     INTEGER REFERENCES deposits(id),
  withdrawal_id  INTEGER REFERENCES withdrawals(id),
  investment_id  INTEGER REFERENCES investments(id),
  reverses_txn_id INTEGER REFERENCES transactions(id),
  audit_log_id   INTEGER REFERENCES audit_logs(id),
  memo           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_user    ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_txn_type    ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_txn_deposit ON transactions(deposit_id);

-- A ledger row may never be deleted, and only its status/updated_at/
-- reverses pointer may change (i.e. marking it reversed).
CREATE TRIGGER IF NOT EXISTS trg_txn_no_delete
BEFORE DELETE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'ledger rows are append-only and cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_txn_immutable_amount
BEFORE UPDATE ON transactions
WHEN old.amount_cents <> new.amount_cents
  OR old.user_id     <> new.user_id
  OR old.direction   <> new.direction
  OR old.type        <> new.type
  OR old.bucket      <> new.bucket
  OR old.currency    <> new.currency
BEGIN
  SELECT RAISE(ABORT, 'ledger rows are immutable; post a reversing entry instead');
END;

-- Derived balances. There is deliberately no `balance` column anywhere.
--
-- Note what is NOT filtered here: a reversed entry still counts. Reversal is
-- performed by posting the mirror image of the original row, and that mirror
-- is what cancels it. Excluding the original as well would undo it twice.
-- `status` marks an entry as superseded for display; it never changes a sum.
DROP VIEW IF EXISTS v_user_balances;
CREATE VIEW v_user_balances AS
SELECT
  u.id AS user_id,
  COALESCE(SUM(CASE WHEN t.bucket='available' AND t.direction='credit'
                    THEN t.amount_cents ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN t.bucket='available' AND t.direction='debit'
                    THEN t.amount_cents ELSE 0 END), 0) AS available_cents,
  COALESCE(SUM(CASE WHEN t.bucket='invested' AND t.direction='credit'
                    THEN t.amount_cents ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN t.bucket='invested' AND t.direction='debit'
                    THEN t.amount_cents ELSE 0 END), 0) AS invested_cents,
  COALESCE(SUM(CASE WHEN t.type='profit_credit' AND t.direction='credit'
                    THEN t.amount_cents ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN t.type='profit_credit' AND t.direction='debit'
                    THEN t.amount_cents ELSE 0 END), 0) AS realized_profit_cents
FROM users u
LEFT JOIN transactions t ON t.user_id = u.id
GROUP BY u.id;

-- ---------------------------------------------------------------------
-- Status history for every workflow entity
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT    NOT NULL CHECK (entity_type IN ('deposit','withdrawal','user','kyc','investment','support','risk_flag')),
  entity_id   INTEGER NOT NULL,
  from_status TEXT,
  to_status   TEXT    NOT NULL,
  actor_type  TEXT    NOT NULL CHECK (actor_type IN ('user','admin','system')),
  actor_id    INTEGER,
  actor_label TEXT,
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_events ON status_events(entity_type, entity_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_status_events_no_delete
BEFORE DELETE ON status_events
BEGIN
  SELECT RAISE(ABORT, 'status history is append-only');
END;

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  severity   TEXT    NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

-- Outbound delivery attempts for SMS/email/WhatsApp, recorded only when a
-- channel is actually configured. Nothing here fakes a send.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  channel         TEXT    NOT NULL CHECK (channel IN ('sms','email','whatsapp')),
  destination     TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('skipped_not_configured','queued','sent','failed')),
  provider_ref    TEXT,
  error           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Support
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ref         TEXT    NOT NULL UNIQUE,             -- SUP-XXXXXX
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT    NOT NULL,
  subject     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','pending_user','answered','closed')),
  priority    TEXT    NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  assigned_to INTEGER REFERENCES admin_users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_requests(status, updated_at);

CREATE TABLE IF NOT EXISTS support_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  author_type TEXT   NOT NULL CHECK (author_type IN ('user','admin')),
  author_id  INTEGER,
  author_label TEXT  NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_msgs ON support_messages(request_id, created_at);

-- ---------------------------------------------------------------------
-- Admin identity, roles and permissions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  description TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id     TEXT    NOT NULL UNIQUE,           -- ADM-XXXXXX
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Sessions (server-side; the cookie only ever carries an opaque token)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_digest TEXT    NOT NULL UNIQUE,
  principal    TEXT    NOT NULL CHECK (principal IN ('user','admin')),
  subject_id   INTEGER NOT NULL,
  csrf_secret  TEXT    NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(principal, subject_id);

-- ---------------------------------------------------------------------
-- Audit log — append-only, no updates, no deletes, enforced by the DB.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type     TEXT    NOT NULL CHECK (actor_type IN ('user','admin','system')),
  actor_id       INTEGER,
  actor_label    TEXT    NOT NULL,
  actor_role     TEXT,
  action         TEXT    NOT NULL,
  entity_type    TEXT,
  entity_id      INTEGER,
  entity_label   TEXT,
  previous_value TEXT,
  new_value      TEXT,
  reason         TEXT,
  ip             TEXT,
  user_agent     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_type, actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

-- ---------------------------------------------------------------------
-- Platform settings + their change history
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  value_type  TEXT NOT NULL CHECK (value_type IN ('string','int','money','bool','text','json')),
  group_key   TEXT NOT NULL,
  label       TEXT NOT NULL,
  help        TEXT NOT NULL DEFAULT '',
  updated_by  INTEGER REFERENCES admin_users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS setting_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL,
  old_value  TEXT,
  new_value  TEXT NOT NULL,
  admin_id   INTEGER REFERENCES admin_users(id),
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_blocks (
  key        TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_by INTEGER REFERENCES admin_users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_id   INTEGER NOT NULL REFERENCES admin_users(id),
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_notes_user ON admin_notes(user_id, created_at);
