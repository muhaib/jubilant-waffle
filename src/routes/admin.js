const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { emitToPlatform } = require('../realtime');

const router = express.Router();
router.use(requireAuth, requireRole('super_admin'));

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function genPassword() {
  return crypto.randomBytes(6).toString('base64url');
}

// List every restaurant client on the platform with a quick order/revenue snapshot.
router.get('/restaurants', (req, res) => {
  const restaurants = db
    .prepare(
      `SELECT r.*,
        (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id) AS order_count,
        (SELECT COUNT(*) FROM users u WHERE u.restaurant_id = r.id AND u.status = 'active') AS staff_count
       FROM restaurants r ORDER BY r.created_at DESC`
    )
    .all();
  res.json({ restaurants });
});

router.get('/restaurants/:id', (req, res) => {
  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  const staff = db
    .prepare('SELECT id, name, email, role, status FROM users WHERE restaurant_id = ? ORDER BY role')
    .all(req.params.id);
  res.json({ restaurant, staff });
});

// Provision a brand new restaurant client + its first owner login, in one call.
router.post('/restaurants', (req, res) => {
  const { name, address, phone, email, plan, currency, tax_rate, owner_name, owner_email } = req.body || {};
  if (!name || !owner_name || !owner_email) {
    return res.status(400).json({ error: 'name, owner_name and owner_email are required' });
  }

  let slug = slugify(name);
  if (!slug) return res.status(400).json({ error: 'Restaurant name produces an empty slug' });
  const clash = db.prepare('SELECT id FROM restaurants WHERE slug = ?').get(slug);
  if (clash) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;

  const ownerEmail = String(owner_email).toLowerCase().trim();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(ownerEmail)) {
    return res.status(409).json({ error: 'A user with that owner email already exists' });
  }

  const tempPassword = genPassword();
  const insertRestaurant = db.prepare(
    `INSERT INTO restaurants (name, slug, address, phone, email, plan, currency, tax_rate, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  );
  const insertOwner = db.prepare(
    `INSERT INTO users (restaurant_id, name, email, password_hash, role, status)
     VALUES (?, ?, ?, ?, 'owner', 'active')`
  );

  const result = db.transaction(() => {
    const info = insertRestaurant.run(
      name,
      slug,
      address || null,
      phone || null,
      email || null,
      plan || 'trial',
      currency || 'USD',
      tax_rate || 0
    );
    const restaurantId = info.lastInsertRowid;
    insertOwner.run(restaurantId, owner_name, ownerEmail, bcrypt.hashSync(tempPassword, 10));
    return restaurantId;
  })();

  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(result);
  emitToPlatform('restaurant:created', { restaurant });

  res.status(201).json({
    restaurant,
    owner_login: { email: ownerEmail, temporary_password: tempPassword },
  });
});

router.patch('/restaurants/:id', (req, res) => {
  const restaurant = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const fields = ['name', 'address', 'phone', 'email', 'plan', 'status', 'currency', 'tax_rate'];
  const updates = [];
  const values = [];
  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(req.params.id);
  db.prepare(`UPDATE restaurants SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
  emitToPlatform('restaurant:updated', { restaurant: updated });
  res.json({ restaurant: updated });
});

// Reset a restaurant owner's password (support action from the master panel).
router.post('/restaurants/:id/reset-owner-password', (req, res) => {
  const owner = db
    .prepare("SELECT id FROM users WHERE restaurant_id = ? AND role = 'owner' ORDER BY id LIMIT 1")
    .get(req.params.id);
  if (!owner) return res.status(404).json({ error: 'No owner account found for this restaurant' });

  const tempPassword = genPassword();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(tempPassword, 10), owner.id);
  res.json({ temporary_password: tempPassword });
});

router.get('/stats', (req, res) => {
  const totals = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM restaurants) AS restaurants,
        (SELECT COUNT(*) FROM restaurants WHERE status = 'active') AS active_restaurants,
        (SELECT COUNT(*) FROM orders) AS orders,
        (SELECT COUNT(*) FROM orders WHERE date(created_at) = date('now')) AS orders_today,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE date(paid_at) = date('now')) AS revenue_today`
    )
    .get();

  const topRestaurants = db
    .prepare(
      `SELECT r.id, r.name, r.slug, COUNT(o.id) AS order_count
       FROM restaurants r LEFT JOIN orders o ON o.restaurant_id = r.id
       GROUP BY r.id ORDER BY order_count DESC LIMIT 5`
    )
    .all();

  res.json({ totals, top_restaurants: topRestaurants });
});

module.exports = router;
