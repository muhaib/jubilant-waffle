const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole, scopeTenant } = require('../auth');

const router = express.Router();
router.use(requireAuth, scopeTenant, requireRole('super_admin', 'owner', 'manager'));

const STAFF_ROLES = ['manager', 'cashier', 'waiter', 'kitchen'];

function genPassword() {
  return crypto.randomBytes(6).toString('base64url');
}

router.get('/', (req, res) => {
  const staff = db
    .prepare("SELECT id, name, email, role, status FROM users WHERE restaurant_id = ? AND role != 'owner' ORDER BY role, name")
    .all(req.restaurantId);
  res.json({ staff });
});

router.post('/', (req, res) => {
  const { name, email, role } = req.body || {};
  if (!name || !email || !STAFF_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${STAFF_ROLES.join(', ')}` });
  }
  const normalizedEmail = String(email).toLowerCase().trim();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail)) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }

  const tempPassword = genPassword();
  const info = db
    .prepare(`INSERT INTO users (restaurant_id, name, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, 'active')`)
    .run(req.restaurantId, name, normalizedEmail, bcrypt.hashSync(tempPassword, 10), role);

  const user = db.prepare('SELECT id, name, email, role, status FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ user, temporary_password: tempPassword });
});

router.patch('/:id', (req, res) => {
  const user = db
    .prepare("SELECT * FROM users WHERE id = ? AND restaurant_id = ? AND role != 'owner'")
    .get(req.params.id, req.restaurantId);
  if (!user) return res.status(404).json({ error: 'Staff member not found' });

  const role = req.body.role ?? user.role;
  const status = req.body.status ?? user.status;
  if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?').run(role, status, user.id);
  res.json({ user: db.prepare('SELECT id, name, email, role, status FROM users WHERE id = ?').get(user.id) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare("DELETE FROM users WHERE id = ? AND restaurant_id = ? AND role != 'owner'").run(req.params.id, req.restaurantId);
  if (!info.changes) return res.status(404).json({ error: 'Staff member not found' });
  res.status(204).end();
});

module.exports = router;
