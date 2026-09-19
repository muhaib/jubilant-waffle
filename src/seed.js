// Populates the database with a demo restaurant so you can explore the
// platform without going through the master admin panel first.
// Usage: npm run seed
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

const OWNER_EMAIL = 'owner@demo-bistro.local';
const OWNER_PASSWORD = 'demo1234';

function run() {
  if (db.prepare('SELECT id FROM restaurants WHERE slug = ?').get('demo-bistro')) {
    console.log('Demo restaurant already exists, skipping seed.');
    return;
  }

  const restaurantId = db
    .prepare(`INSERT INTO restaurants (name, slug, plan, status, currency) VALUES ('Demo Bistro', 'demo-bistro', 'pro', 'active', 'USD')`)
    .run().lastInsertRowid;

  db.prepare(
    `INSERT INTO users (restaurant_id, name, email, password_hash, role, status) VALUES (?, 'Demo Owner', ?, ?, 'owner', 'active')`
  ).run(restaurantId, OWNER_EMAIL, bcrypt.hashSync(OWNER_PASSWORD, 10));

  const catId = db
    .prepare(`INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (?, 'Mains', 0)`)
    .run(restaurantId).lastInsertRowid;
  const catId2 = db
    .prepare(`INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES (?, 'Drinks', 1)`)
    .run(restaurantId).lastInsertRowid;

  const insertItem = db.prepare(
    `INSERT INTO menu_items (restaurant_id, category_id, name, price, tax_rate) VALUES (?, ?, ?, ?, ?)`
  );
  insertItem.run(restaurantId, catId, 'Cheeseburger', 8.99, 0);
  insertItem.run(restaurantId, catId, 'Margherita Pizza', 10.5, 0);
  insertItem.run(restaurantId, catId, 'Caesar Salad', 7.25, 0);
  insertItem.run(restaurantId, catId2, 'Soda', 2.0, 0);
  insertItem.run(restaurantId, catId2, 'Iced Tea', 2.5, 0);

  const insertTable = db.prepare(`INSERT INTO dining_tables (restaurant_id, name, capacity) VALUES (?, ?, ?)`);
  insertTable.run(restaurantId, 'T1', 2);
  insertTable.run(restaurantId, 'T2', 4);
  insertTable.run(restaurantId, 'T3', 4);

  console.log('Seeded demo restaurant.');
  console.log(`  Owner login: ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
}

run();
