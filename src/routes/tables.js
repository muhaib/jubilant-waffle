const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, scopeTenant } = require('../auth');
const { emitToTenant } = require('../realtime');

const router = express.Router();
router.use(requireAuth, scopeTenant);

const canManage = requireRole('super_admin', 'owner', 'manager');

router.get('/', (req, res) => {
  const tables = db.prepare('SELECT * FROM dining_tables WHERE restaurant_id = ? ORDER BY name').all(req.restaurantId);
  res.json({ tables });
});

router.post('/', canManage, (req, res) => {
  const { name, capacity } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare('INSERT INTO dining_tables (restaurant_id, name, capacity) VALUES (?, ?, ?)')
    .run(req.restaurantId, name, capacity || 2);
  res.status(201).json({ table: db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(info.lastInsertRowid) });
});

router.patch('/:id', (req, res) => {
  const table = db.prepare('SELECT * FROM dining_tables WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurantId);
  if (!table) return res.status(404).json({ error: 'Table not found' });

  const name = req.body.name ?? table.name;
  const capacity = req.body.capacity ?? table.capacity;
  const status = req.body.status ?? table.status;
  if (!['free', 'occupied', 'reserved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare('UPDATE dining_tables SET name = ?, capacity = ?, status = ? WHERE id = ?').run(name, capacity, status, table.id);
  const updated = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(table.id);
  emitToTenant(req.restaurantId, 'table:updated', { table: updated });
  res.json({ table: updated });
});

router.delete('/:id', canManage, (req, res) => {
  const info = db.prepare('DELETE FROM dining_tables WHERE id = ? AND restaurant_id = ?').run(req.params.id, req.restaurantId);
  if (!info.changes) return res.status(404).json({ error: 'Table not found' });
  res.status(204).end();
});

module.exports = router;
