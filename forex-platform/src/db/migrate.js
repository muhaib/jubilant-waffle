'use strict';
const { db, tx, migrate } = require('./index');
const config = require('../config');
const ref = require('./reference');
const { hashPassword } = require('../lib/password');
const { uniqueRef } = require('../lib/ids');

// Tables must exist before the statements below are prepared.
migrate();

/**
 * Idempotent migration + reference data sync. Safe to run on every deploy.
 *
 * Deliberately conservative: it inserts missing rows and syncs role↔permission
 * mappings, but never overwrites a setting value, a content block or a payment
 * account number an operator has edited through the admin panel.
 */

const upsertPermission = db.prepare(`
  INSERT INTO permissions (key, description) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET description = excluded.description
`);
const upsertRole = db.prepare(`
  INSERT INTO roles (key, name, description) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description
`);
const insertSetting = db.prepare(`
  INSERT INTO platform_settings (key, value, value_type, group_key, label, help)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(key) DO UPDATE SET
    value_type = excluded.value_type,
    group_key  = excluded.group_key,
    label      = excluded.label,
    help       = excluded.help
`);
const insertContent = db.prepare(
  `INSERT INTO content_blocks (key, title, body) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING`
);
const insertMethod = db.prepare(`
  INSERT INTO payment_methods (key, name, provider, account_title, account_number, instructions,
                               for_deposit, for_withdrawal, is_active, sort_order)
  VALUES (@key, @name, @provider, @account_title, @account_number, @instructions,
          @for_deposit, @for_withdrawal, @is_active, @sort_order)
  ON CONFLICT(key) DO NOTHING
`);

const run = tx(() => {
  for (const [key, description] of ref.PERMISSIONS) upsertPermission.run(key, description);

  const permIds = new Map(db.prepare('SELECT id, key FROM permissions').all().map((p) => [p.key, p.id]));

  for (const role of ref.ROLES) {
    upsertRole.run(role.key, role.name, role.description);
    const roleId = db.prepare('SELECT id FROM roles WHERE key = ?').get(role.key).id;
    const want = role.permissions === '*' ? [...permIds.keys()] : role.permissions;
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    const link = db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?,?)');
    for (const key of want) {
      const pid = permIds.get(key);
      if (!pid) throw new Error(`Role ${role.key} references unknown permission ${key}`);
      link.run(roleId, pid);
    }
  }

  for (const [key, value, type, group, label, help] of ref.SETTINGS) {
    insertSetting.run(key, value, type, group, label, help);
  }
  for (const c of ref.CONTENT) insertContent.run(c.key, c.title, c.body);
  for (const m of ref.PAYMENT_METHODS) {
    insertMethod.run({ is_active: 1, ...m });
  }
});

/**
 * Create the first Super Admin from the environment, once. Never resets an
 * existing password — recovery is a deliberate, separate operation.
 */
function bootstrapAdmin() {
  const { email, password, name } = config.bootstrapAdmin;
  const existing = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get().c;
  if (existing > 0) return { created: false, reason: 'administrators already exist' };
  if (!email || !password) {
    return { created: false, reason: 'BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set' };
  }
  if (password.length < 12) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
  }
  const roleId = db.prepare(`SELECT id FROM roles WHERE key = 'super_admin'`).get().id;
  const publicId = uniqueRef('ADM', 6, (c) => !!db.prepare('SELECT 1 FROM admin_users WHERE public_id = ?').get(c));
  db.prepare(`
    INSERT INTO admin_users (public_id, name, email, password_hash, role_id, must_change_password)
    VALUES (?,?,?,?,?,1)
  `).run(publicId, name, email.toLowerCase(), hashPassword(password), roleId);
  db.prepare(`
    INSERT INTO audit_logs (actor_type, actor_label, action, entity_type, entity_label, new_value, reason)
    VALUES ('system', 'bootstrap', 'admin.created', 'admin_user', ?, ?, 'Initial super admin created from environment configuration')
  `).run(publicId, JSON.stringify({ email: email.toLowerCase(), role: 'super_admin' }));
  return { created: true, publicId, email: email.toLowerCase() };
}

function apply() {
  migrate();
  run();
  return bootstrapAdmin();
}

if (require.main === module) {
  const result = apply();
  const counts = {
    permissions: db.prepare('SELECT COUNT(*) c FROM permissions').get().c,
    roles: db.prepare('SELECT COUNT(*) c FROM roles').get().c,
    settings: db.prepare('SELECT COUNT(*) c FROM platform_settings').get().c,
    content: db.prepare('SELECT COUNT(*) c FROM content_blocks').get().c,
    methods: db.prepare('SELECT COUNT(*) c FROM payment_methods').get().c,
  };
  console.log('Migration applied.', counts);
  if (result.created) {
    console.log(`Super Admin created: ${result.email} (${result.publicId}). It must change its password at first sign-in.`);
  } else {
    console.log(`Super Admin not created — ${result.reason}.`);
  }
}

module.exports = { apply, bootstrapAdmin };
