'use strict';
const config = require('../config');

/**
 * Outbound SMS.
 *
 * No provider is wired up by default. Rather than pretending a message was
 * delivered, send() reports exactly what happened so the caller (and the
 * notification_deliveries table) records the truth:
 *
 *   skipped_not_configured — no provider set; nothing left this server
 *   sent                   — provider accepted the message
 *   failed                 — provider rejected it
 *
 * To go live, implement `deliver` for your provider and set SMS_PROVIDER.
 */
async function deliver(/* provider, to, body */) {
  throw new Error(
    `SMS provider "${config.sms.provider}" has no adapter implemented in src/lib/sms.js`
  );
}

function isConfigured() {
  return Boolean(config.sms.provider && config.sms.apiKey);
}

async function send(to, body) {
  if (!isConfigured()) {
    return { status: 'skipped_not_configured', providerRef: null, error: null };
  }
  try {
    const ref = await deliver(config.sms.provider, to, body);
    return { status: 'sent', providerRef: ref || null, error: null };
  } catch (err) {
    return { status: 'failed', providerRef: null, error: err.message };
  }
}

module.exports = { send, isConfigured };
