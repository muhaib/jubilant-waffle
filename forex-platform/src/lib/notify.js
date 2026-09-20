'use strict';
const { db } = require('../db');
const sms = require('./sms');
const settings = require('./settings');

const insertNotification = db.prepare(`
  INSERT INTO notifications (user_id, type, severity, title, body, link)
  VALUES (@user_id, @type, @severity, @title, @body, @link)
`);
const insertDelivery = db.prepare(`
  INSERT INTO notification_deliveries (notification_id, channel, destination, status, provider_ref, error)
  VALUES (?,?,?,?,?,?)
`);

/**
 * Create an in-app notification. External channels are attempted only when
 * a provider is actually configured; every attempt (including the "not
 * configured, nothing sent" case) is recorded rather than assumed.
 */
function notify(userId, { type, title, body, link = null, severity = 'info', smsText = null }) {
  const info = insertNotification.run({
    user_id: userId, type, severity, title, body, link,
  });
  const id = Number(info.lastInsertRowid);

  if (smsText && settings.get('sms_notifications_enabled', false)) {
    const user = db.prepare('SELECT phone_e164 FROM users WHERE id = ?').get(userId);
    if (user) {
      sms.send(user.phone_e164, smsText).then((r) => {
        insertDelivery.run(id, 'sms', user.phone_e164, r.status, r.providerRef, r.error);
      }).catch((err) => {
        insertDelivery.run(id, 'sms', user.phone_e164, 'failed', null, err.message);
      });
    }
  }
  return id;
}

const listStmt = db.prepare(
  'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
);
const unreadStmt = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL');
const markReadStmt = db.prepare(
  `UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`
);
const markOneStmt = db.prepare(
  `UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL`
);

module.exports = {
  notify,
  list: (userId, limit = 30, offset = 0) => listStmt.all(userId, limit, offset),
  unreadCount: (userId) => unreadStmt.get(userId).c,
  markAllRead: (userId) => markReadStmt.run(userId).changes,
  markRead: (id, userId) => markOneStmt.run(id, userId).changes,
};
