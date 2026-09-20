'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// WAL gives us concurrent readers alongside a writer; FULL synchronous keeps
// a committed financial write durable across an OS crash.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * Run `fn` inside an IMMEDIATE transaction. Every multi-row financial
 * mutation goes through this so a partial write can never be observed.
 */
function tx(fn) {
  const wrapped = db.transaction(fn);
  return (...args) => wrapped.immediate(...args);
}

function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
}

module.exports = { db, tx, migrate };
