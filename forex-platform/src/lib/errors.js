'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const bad        = (msg, details) => new AppError(400, 'bad_request', msg, details);
const invalid    = (details)      => new AppError(422, 'validation_failed', 'Please correct the highlighted fields.', details);
const unauth     = (msg = 'You need to sign in to continue.') => new AppError(401, 'unauthenticated', msg);
const forbidden  = (msg = 'You do not have permission to do that.') => new AppError(403, 'forbidden', msg);
const notFound   = (msg = 'Not found.') => new AppError(404, 'not_found', msg);
const conflict   = (msg, details) => new AppError(409, 'conflict', msg, details);
const tooMany    = (msg, retryAfter) => Object.assign(new AppError(429, 'rate_limited', msg), { retryAfter });

module.exports = { AppError, bad, invalid, unauth, forbidden, notFound, conflict, tooMany };
