'use strict';
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const { db } = require('../db');
const { sha256 } = require('../lib/crypto');
const { randomToken } = require('../lib/ids');
const { bad } = require('../lib/errors');

fs.mkdirSync(config.uploadDir, { recursive: true });

/**
 * Upload handling.
 *
 * Files are buffered in memory, validated by content (not by the filename or
 * the client-supplied Content-Type, both of which are attacker-controlled),
 * renamed to a server-generated random name with a fixed extension, and
 * written outside the web root. They are only ever readable through
 * /api/files/:id, which checks ownership or an admin permission first.
 */
const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 25 },
});

const single = (field) => (req, res, next) => memory.single(field)(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    const mb = Math.floor(config.uploads.maxBytes / (1024 * 1024));
    return next(bad(`That file is larger than the ${mb} MB upload limit.`));
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(bad('Unexpected file field.'));
  return next(bad('The file could not be read. Please try again.'));
});

/** Magic-number sniffing. Only real JPEG and PNG bytes are accepted. */
function sniff(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => buffer[i] === b)) return { mime: 'image/png', ext: '.png' };
  return null;
}

/**
 * Cheap content screen: reject an image that also contains markup or script
 * tags, the classic polyglot trick against naive viewers. This is not a
 * virus scanner — wire ClamAV (or your provider's scanner) into `scanHook`
 * for that, and files stay `not_scanned` until it reports back.
 */
const DANGEROUS = [/<\s*script/i, /<\s*iframe/i, /<\s*\?php/i, /<!DOCTYPE\s+html/i, /<\s*svg/i];
function looksPolyglot(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString('latin1');
  return DANGEROUS.some((re) => re.test(head));
}

let scanHook = null;
function setScanHook(fn) { scanHook = fn; }

const insertFile = db.prepare(`
  INSERT INTO files (owner_user_id, kind, original_name, stored_name, mime, size_bytes, sha256, scan_status, scan_note)
  VALUES (?,?,?,?,?,?,?,?,?)
`);

/**
 * Persist a validated upload. Throws a 400 with a specific, user-readable
 * reason for every rejection path.
 */
async function storeUpload(file, { ownerUserId, kind }) {
  if (!file || !file.buffer?.length) throw bad('Please attach a file.');
  const detected = sniff(file.buffer);
  if (!detected) throw bad('Only JPEG or PNG images are accepted. That file is neither.');
  if (!config.uploads.allowedMime.includes(detected.mime)) {
    throw bad('Only JPEG or PNG images are accepted.');
  }
  if (looksPolyglot(file.buffer)) {
    throw bad('That file was rejected because it contains embedded markup or script content.');
  }

  const storedName = `${Date.now().toString(36)}-${randomToken(16)}${detected.ext}`;
  const destination = path.join(config.uploadDir, storedName);
  // Resolve-and-compare guards against any traversal in a generated name.
  if (path.dirname(path.resolve(destination)) !== path.resolve(config.uploadDir)) {
    throw new Error('Refusing to write outside the upload directory');
  }

  let scanStatus = 'not_scanned';
  let scanNote = 'No malware scanner is configured for this deployment.';
  if (scanHook) {
    try {
      const verdict = await scanHook(file.buffer);
      scanStatus = verdict.clean ? 'clean' : 'suspect';
      scanNote = verdict.note || null;
      if (!verdict.clean) throw bad('That file was rejected by the malware scanner.');
    } catch (err) {
      if (err.status === 400) throw err;
      scanStatus = 'error';
      scanNote = err.message;
    }
  }

  fs.writeFileSync(destination, file.buffer, { mode: 0o600 });

  const info = insertFile.run(
    ownerUserId, kind, String(file.originalname || 'upload').slice(0, 200),
    storedName, detected.mime, file.buffer.length, sha256(file.buffer), scanStatus, scanNote
  );
  return { id: Number(info.lastInsertRowid), storedName, mime: detected.mime, size: file.buffer.length };
}

function absolutePathFor(storedName) {
  const resolved = path.resolve(config.uploadDir, storedName);
  if (path.dirname(resolved) !== path.resolve(config.uploadDir)) return null;
  return resolved;
}

module.exports = { single, storeUpload, absolutePathFor, setScanHook, sniff };
