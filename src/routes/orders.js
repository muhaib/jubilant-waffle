const express = require('express');
const db = require('../db');
const { requireAuth, scopeTenant } = require('../auth');
const { emitToTenant } = require('../realtime');

const router = express.Router();
router.use(requireAuth, scopeTenant);

const ORDER_STATUSES = ['open', 'preparing', 'ready', 'served', 'billed', 'paid', 'cancelled'];
const ITEM_STATUSES = ['pending', 'preparing', 'ready', 'served', 'cancelled'];

// Resolves a cart line to its authoritative name/price server-side — the
// client only sends menu_item_id (+ optional size_id) and quantity, never a
// price, so a tampered request can't under-charge an order.
function resolveLine(line, restaurantId) {
  const menuItem = db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?').get(line.menu_item_id, restaurantId);
  if (!menuItem) return null;

  if (line.size_id) {
    const size = db.prepare('SELECT * FROM menu_item_sizes WHERE id = ? AND menu_item_id = ?').get(line.size_id, menuItem.id);
    if (!size) return null;
    return { menuItemId: menuItem.id, name: `${menuItem.name} (${size.name})`, price: size.price };
  }
  return { menuItemId: menuItem.id, name: menuItem.name, price: menuItem.price };
}

function loadOrder(id, restaurantId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND restaurant_id = ?').get(id, restaurantId);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  order.payments = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(id);
  order.total = order.items
    .filter((i) => i.status !== 'cancelled')
    .reduce((sum, i) => sum + i.price_snapshot * i.qty * (1 + 0), 0);
  order.paid_total = order.payments.reduce((sum, p) => sum + p.amount, 0);
  return order;
}

// Active board: everything not yet fully paid/cancelled, newest first.
router.get('/', (req, res) => {
  const status = req.query.status;
  let rows;
  if (status) {
    rows = db
      .prepare('SELECT id FROM orders WHERE restaurant_id = ? AND status = ? ORDER BY created_at DESC')
      .all(req.restaurantId, status);
  } else {
    rows = db
      .prepare(
        `SELECT id FROM orders WHERE restaurant_id = ? AND status NOT IN ('paid', 'cancelled') ORDER BY created_at DESC`
      )
      .all(req.restaurantId);
  }
  const orders = rows.map((r) => loadOrder(r.id, req.restaurantId));
  res.json({ orders });
});

router.get('/:id', (req, res) => {
  const order = loadOrder(req.params.id, req.restaurantId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

router.post('/', (req, res) => {
  const { table_id, order_type, customer_name, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'At least one item is required' });
  }

  const resolved = items.map((line) => resolveLine(line, req.restaurantId));
  const badIndex = resolved.findIndex((r) => !r);
  if (badIndex !== -1) {
    return res.status(400).json({ error: `Menu item ${items[badIndex].menu_item_id} (or its size) was not found for this restaurant` });
  }

  const result = db.transaction(() => {
    const orderInfo = db
      .prepare(
        `INSERT INTO orders (restaurant_id, table_id, order_type, status, customer_name, created_by)
         VALUES (?, ?, ?, 'open', ?, ?)`
      )
      .run(req.restaurantId, table_id || null, order_type || 'dine_in', customer_name || null, req.user.id);
    const orderId = orderInfo.lastInsertRowid;

    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, price_snapshot, qty, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    );
    items.forEach((line, i) => {
      const r = resolved[i];
      insertItem.run(orderId, r.menuItemId, r.name, r.price, line.qty || 1, line.notes || null);
    });

    if (table_id) {
      db.prepare("UPDATE dining_tables SET status = 'occupied' WHERE id = ? AND restaurant_id = ?").run(table_id, req.restaurantId);
    }
    return orderId;
  })();

  const order = loadOrder(result, req.restaurantId);
  emitToTenant(req.restaurantId, 'order:new', { order });
  res.status(201).json({ order });
});

// Add more items to an already-open order (e.g. a second round).
router.post('/:id/items', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurantId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (['paid', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ error: 'Cannot add items to a closed order' });
  }

  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one item is required' });

  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, price_snapshot, qty, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  );
  const tx = db.transaction(() => {
    for (const line of items) {
      const r = resolveLine(line, req.restaurantId);
      if (!r) throw new Error('bad_item');
      insertItem.run(order.id, r.menuItemId, r.name, r.price, line.qty || 1, line.notes || null);
    }
    db.prepare("UPDATE orders SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(order.id);
  });

  try {
    tx();
  } catch (e) {
    if (e.message === 'bad_item') return res.status(400).json({ error: 'One or more menu items were not found' });
    throw e;
  }

  const updated = loadOrder(order.id, req.restaurantId);
  emitToTenant(req.restaurantId, 'order:updated', { order: updated });
  res.status(201).json({ order: updated });
});

router.patch('/:id/items/:itemId', (req, res) => {
  const item = db
    .prepare(
      `SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.id = ? AND oi.order_id = ? AND o.restaurant_id = ?`
    )
    .get(req.params.itemId, req.params.id, req.restaurantId);
  if (!item) return res.status(404).json({ error: 'Order item not found' });

  const status = req.body.status ?? item.status;
  const qty = req.body.qty ?? item.qty;
  if (!ITEM_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid item status' });

  db.prepare('UPDATE order_items SET status = ?, qty = ? WHERE id = ?').run(status, qty, item.id);
  const order = loadOrder(req.params.id, req.restaurantId);
  emitToTenant(req.restaurantId, 'order_item:updated', { order });
  res.json({ order });
});

router.patch('/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurantId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const status = req.body.status;
  if (status && !ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid order status' });

  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status || order.status, order.id);

  if (status === 'paid' || status === 'cancelled') {
    if (order.table_id) {
      db.prepare("UPDATE dining_tables SET status = 'free' WHERE id = ?").run(order.table_id);
    }
  }

  const updated = loadOrder(order.id, req.restaurantId);
  emitToTenant(req.restaurantId, 'order:updated', { order: updated });
  res.json({ order: updated });
});

router.post('/:id/payments', (req, res) => {
  const order = loadOrder(req.params.id, req.restaurantId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { amount, method } = req.body || {};
  if (!amount || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' });

  db.prepare(
    `INSERT INTO payments (order_id, restaurant_id, amount, method, received_by) VALUES (?, ?, ?, ?, ?)`
  ).run(order.id, req.restaurantId, amount, method || 'cash', req.user.id);

  const paidTotal = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = ?').get(order.id).total;
  const nowFullyPaid = paidTotal >= order.total;
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
    nowFullyPaid ? 'paid' : 'billed',
    order.id
  );
  if (nowFullyPaid && order.table_id) {
    db.prepare("UPDATE dining_tables SET status = 'free' WHERE id = ?").run(order.table_id);
  }

  const updated = loadOrder(order.id, req.restaurantId);
  emitToTenant(req.restaurantId, 'order:updated', { order: updated });
  res.status(201).json({ order: updated });
});

module.exports = router;
