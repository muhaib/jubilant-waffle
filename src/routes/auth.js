const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'This account has been disabled' });
  }

  if (user.restaurant_id) {
    const restaurant = db.prepare('SELECT status FROM restaurants WHERE id = ?').get(user.restaurant_id);
    if (!restaurant || restaurant.status !== 'active') {
      return res.status(403).json({ error: 'This restaurant account is suspended' });
    }
  }

  const token = signToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      restaurant_id: user.restaurant_id,
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, restaurant_id FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let restaurant = null;
  if (user.restaurant_id) {
    restaurant = db.prepare('SELECT id, name, slug, plan, status, currency FROM restaurants WHERE id = ?').get(user.restaurant_id);
  }
  res.json({ user, restaurant });
});

module.exports = router;
