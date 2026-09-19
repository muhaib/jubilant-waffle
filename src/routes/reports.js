const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, scopeTenant } = require('../auth');

const router = express.Router();
router.use(requireAuth, scopeTenant, requireRole('super_admin', 'owner', 'manager'));

router.get('/daily', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  const summary = db
    .prepare(
      `SELECT
        COUNT(DISTINCT o.id) AS order_count,
        COALESCE(SUM(p.amount), 0) AS revenue
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id AND date(p.paid_at) = ?
       WHERE o.restaurant_id = ? AND date(o.created_at) = ?`
    )
    .get(date, req.restaurantId, date);

  const topItems = db
    .prepare(
      `SELECT oi.name_snapshot AS name, SUM(oi.qty) AS qty_sold, SUM(oi.qty * oi.price_snapshot) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND date(o.created_at) = ? AND oi.status != 'cancelled'
       GROUP BY oi.name_snapshot ORDER BY qty_sold DESC LIMIT 10`
    )
    .all(req.restaurantId, date);

  const byPaymentMethod = db
    .prepare(
      `SELECT method, COUNT(*) AS count, SUM(amount) AS total
       FROM payments WHERE restaurant_id = ? AND date(paid_at) = ? GROUP BY method`
    )
    .all(req.restaurantId, date);

  res.json({ date, summary, top_items: topItems, by_payment_method: byPaymentMethod });
});

module.exports = router;
