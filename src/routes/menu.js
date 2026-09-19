const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole, scopeTenant } = require('../auth');

const router = express.Router();
router.use(requireAuth, scopeTenant);

const canManage = requireRole('super_admin', 'owner', 'manager');

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, String(req.restaurantId));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) return cb(new Error('Only JPEG, PNG, WebP or GIF images are allowed'));
    cb(null, true);
  },
});

function uploadImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

router.post('/images', canManage, uploadImage, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file received' });
  res.status(201).json({ url: `/uploads/${req.restaurantId}/${req.file.filename}` });
});

function attachSizes(item) {
  item.sizes = db
    .prepare('SELECT * FROM menu_item_sizes WHERE menu_item_id = ? ORDER BY sort_order, id')
    .all(item.id);
  return item;
}

router.get('/categories', (req, res) => {
  const categories = db
    .prepare('SELECT * FROM menu_categories WHERE restaurant_id = ? ORDER BY sort_order, name')
    .all(req.restaurantId);
  res.json({ categories });
});

router.post('/categories', canManage, (req, res) => {
  const { name, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare('INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (?, ?, ?)')
    .run(req.restaurantId, name, sort_order || 0);
  res.status(201).json({ category: db.prepare('SELECT * FROM menu_categories WHERE id = ?').get(info.lastInsertRowid) });
});

router.patch('/categories/:id', canManage, (req, res) => {
  const category = db
    .prepare('SELECT * FROM menu_categories WHERE id = ? AND restaurant_id = ?')
    .get(req.params.id, req.restaurantId);
  if (!category) return res.status(404).json({ error: 'Category not found' });

  const name = req.body.name ?? category.name;
  const sortOrder = req.body.sort_order ?? category.sort_order;
  db.prepare('UPDATE menu_categories SET name = ?, sort_order = ? WHERE id = ?').run(name, sortOrder, category.id);
  res.json({ category: db.prepare('SELECT * FROM menu_categories WHERE id = ?').get(category.id) });
});

router.delete('/categories/:id', canManage, (req, res) => {
  const info = db.prepare('DELETE FROM menu_categories WHERE id = ? AND restaurant_id = ?').run(req.params.id, req.restaurantId);
  if (!info.changes) return res.status(404).json({ error: 'Category not found' });
  res.status(204).end();
});

router.get('/items', (req, res) => {
  const items = db
    .prepare('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY category_id, name')
    .all(req.restaurantId)
    .map(attachSizes);
  res.json({ items });
});

router.post('/items', canManage, (req, res) => {
  const { category_id, name, description, price, tax_rate, is_available, image_url } = req.body || {};
  if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });

  const info = db
    .prepare(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, tax_rate, is_available, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.restaurantId,
      category_id || null,
      name,
      description || null,
      price,
      tax_rate || 0,
      is_available === false ? 0 : 1,
      image_url || null
    );
  res.status(201).json({ item: attachSizes(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/items/:id', canManage, (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurantId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  const merged = { ...item, ...req.body };
  db.prepare(
    `UPDATE menu_items SET category_id = ?, name = ?, description = ?, price = ?, tax_rate = ?, is_available = ?, image_url = ?
     WHERE id = ?`
  ).run(
    merged.category_id || null,
    merged.name,
    merged.description || null,
    merged.price,
    merged.tax_rate || 0,
    merged.is_available ? 1 : 0,
    merged.image_url || null,
    item.id
  );
  res.json({ item: attachSizes(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(item.id)) });
});

router.delete('/items/:id', canManage, (req, res) => {
  const info = db.prepare('DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?').run(req.params.id, req.restaurantId);
  if (!info.changes) return res.status(404).json({ error: 'Menu item not found' });
  res.status(204).end();
});

function loadItem(id, restaurantId) {
  return db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?').get(id, restaurantId);
}

// Size modifiers (e.g. Small/Medium/Large), each with its own price. When an
// item has any, the POS asks which one to add to the cart instead of using
// the item's base price directly.
router.post('/items/:id/sizes', canManage, (req, res) => {
  const item = loadItem(req.params.id, req.restaurantId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  const { name, price, sort_order } = req.body || {};
  if (!name || price === undefined || price === null || Number(price) <= 0) {
    return res.status(400).json({ error: 'name and a positive price are required' });
  }

  const info = db
    .prepare('INSERT INTO menu_item_sizes (menu_item_id, name, price, sort_order) VALUES (?, ?, ?, ?)')
    .run(item.id, name, price, sort_order || 0);
  res.status(201).json({ size: db.prepare('SELECT * FROM menu_item_sizes WHERE id = ?').get(info.lastInsertRowid) });
});

router.patch('/items/:id/sizes/:sizeId', canManage, (req, res) => {
  const item = loadItem(req.params.id, req.restaurantId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  const size = db.prepare('SELECT * FROM menu_item_sizes WHERE id = ? AND menu_item_id = ?').get(req.params.sizeId, item.id);
  if (!size) return res.status(404).json({ error: 'Size not found' });

  const name = req.body.name ?? size.name;
  const price = req.body.price ?? size.price;
  if (!name || Number(price) <= 0) return res.status(400).json({ error: 'name and a positive price are required' });

  db.prepare('UPDATE menu_item_sizes SET name = ?, price = ? WHERE id = ?').run(name, price, size.id);
  res.json({ size: db.prepare('SELECT * FROM menu_item_sizes WHERE id = ?').get(size.id) });
});

router.delete('/items/:id/sizes/:sizeId', canManage, (req, res) => {
  const item = loadItem(req.params.id, req.restaurantId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  const info = db.prepare('DELETE FROM menu_item_sizes WHERE id = ? AND menu_item_id = ?').run(req.params.sizeId, item.id);
  if (!info.changes) return res.status(404).json({ error: 'Size not found' });
  res.status(204).end();
});

module.exports = router;
