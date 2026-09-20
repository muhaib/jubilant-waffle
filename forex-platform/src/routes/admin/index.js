'use strict';
const express = require('express');
const { db } = require('../../db');
const audit = require('../../lib/audit');
const { attachAdmin, requireAdmin } = require('../../middleware/auth');
const { asyncRoute } = require('../../middleware/common');
const { serveFile } = require('../account');
const { forbidden, notFound } = require('../../lib/errors');

const router = express.Router();

// Every admin request resolves its principal and permission set first.
router.use(attachAdmin);

const { router: authRouter } = require('./auth');
router.use('/auth', authRouter);

// Everything past this point requires an administrator session.
router.use(requireAdmin);

router.use(require('./overview'));
router.use(require('./users'));
router.use(require('./finance'));
router.use(require('./config'));
router.use(require('./oversight'));

/**
 * Administrative file access. Deposit evidence needs deposits.view; identity
 * images need kyc.view. Reading an identity image is recorded — looking at
 * someone's documents is itself an auditable event.
 */
const fileMeta = db.prepare('SELECT id, kind, owner_user_id FROM files WHERE id = ?');

router.get('/files/:id', asyncRoute(async (req, res) => {
  const meta = fileMeta.get(Number(req.params.id));
  if (!meta) throw notFound('No such file.');

  const needed = meta.kind === 'deposit_evidence' ? 'deposits.view' : 'kyc.view';
  if (!req.adminPermissions.has(needed)) {
    throw forbidden(`Your role does not include the ${needed} permission.`);
  }
  if (meta.kind !== 'deposit_evidence') {
    const owner = db.prepare('SELECT public_id FROM users WHERE id = ?').get(meta.owner_user_id);
    audit.record(req, {
      action: 'kyc.image_viewed', entityType: 'file', entityId: meta.id,
      entityLabel: owner?.public_id || null,
    });
  }
  return serveFile(req, res, { isAdmin: true });
}));

module.exports = router;
