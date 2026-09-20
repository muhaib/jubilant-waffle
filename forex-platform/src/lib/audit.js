'use strict';
const { db } = require('../db');

const insertAudit = db.prepare(`
  INSERT INTO audit_logs
    (actor_type, actor_id, actor_label, actor_role, action, entity_type, entity_id,
     entity_label, previous_value, new_value, reason, ip, user_agent)
  VALUES (@actor_type, @actor_id, @actor_label, @actor_role, @action, @entity_type, @entity_id,
          @entity_label, @previous_value, @new_value, @reason, @ip, @user_agent)
`);

const insertStatusEvent = db.prepare(`
  INSERT INTO status_events (entity_type, entity_id, from_status, to_status, actor_type, actor_id, actor_label, note)
  VALUES (@entity_type, @entity_id, @from_status, @to_status, @actor_type, @actor_id, @actor_label, @note)
`);

function serialise(v) {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Write one append-only audit record. Returns the new row id so financial
 * rows can reference the audit entry that authorised them.
 *
 * `req` is optional and only used to capture IP / user agent.
 */
function record(req, {
  action, entityType = null, entityId = null, entityLabel = null,
  previous, next, reason = null, actor,
}) {
  const a = actor || req?.actor || { type: 'system', id: null, label: 'system', role: null };
  const info = insertAudit.run({
    actor_type: a.type,
    actor_id: a.id ?? null,
    actor_label: a.label,
    actor_role: a.role ?? null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    entity_label: entityLabel,
    previous_value: serialise(previous),
    new_value: serialise(next),
    reason,
    ip: req?.clientIp ?? null,
    user_agent: req?.get?.('user-agent')?.slice(0, 400) ?? null,
  });
  return info.lastInsertRowid;
}

function status(req, { entityType, entityId, from, to, note = null, actor }) {
  const a = actor || req?.actor || { type: 'system', id: null, label: 'system' };
  insertStatusEvent.run({
    entity_type: entityType,
    entity_id: entityId,
    from_status: from ?? null,
    to_status: to,
    actor_type: a.type,
    actor_id: a.id ?? null,
    actor_label: a.label,
    note,
  });
}

const historyStmt = db.prepare(
  `SELECT * FROM status_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC, id ASC`
);
const historyFor = (entityType, entityId) => historyStmt.all(entityType, entityId);

module.exports = { record, status, historyFor };
