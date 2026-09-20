'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const config = require('./src/config');
const { apply: applyMigrations } = require('./src/db/migrate');
const settings = require('./src/lib/settings');
const { clientIp, notFound, errorHandler, asyncRoute } = require('./src/middleware/common');
const { attachUser } = require('./src/middleware/auth');

// Schema and reference data are applied on boot so a fresh deployment comes
// up complete. It is idempotent and never overwrites operator-edited values.
const bootstrap = applyMigrations();

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

/**
 * Security headers. The CSP is strict: no inline scripts anywhere, so a
 * reflected or stored string can never execute. Styles allow 'unsafe-inline'
 * only for the small number of inline style attributes the charts set for
 * positioning; everything else is an external stylesheet.
 */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());
app.use(clientIp);

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

/**
 * Maintenance mode. Administrators keep full access so the platform can be
 * fixed from the inside; everyone else gets a clear, honest page.
 */
app.use((req, res, next) => {
  if (!settings.get('maintenance_mode', false)) return next();
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin') || req.path === '/healthz') return next();
  if (req.path.startsWith('/assets/')) return next();
  const message = settings.get('maintenance_message', 'We are carrying out scheduled maintenance.');
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ error: { code: 'maintenance', message } });
  }
  return res.status(503).sendFile(path.join(__dirname, 'public', 'maintenance.html'));
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.use('/api/public', require('./src/routes/public'));
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/admin', require('./src/routes/admin'));

// User-scoped API: one place where the session is resolved.
const userApi = express.Router();
userApi.use(attachUser);
userApi.use('/me', require('./src/routes/me'));
userApi.use('/deposits', require('./src/routes/deposits'));
userApi.use('/withdrawals', require('./src/routes/withdrawals'));
userApi.use('/investments', require('./src/routes/investments'));
userApi.use(require('./src/routes/account').router);
app.use('/api', userApi);

// ---------------------------------------------------------------------------
// Static site and single-page apps
// ---------------------------------------------------------------------------
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  maxAge: config.isProd ? '1h' : 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  },
}));

app.get(['/app', '/app/*'], (req, res) => res.sendFile(path.join(publicDir, 'app', 'index.html')));
app.get(['/admin', '/admin/*'], (req, res) => res.sendFile(path.join(publicDir, 'admin', 'index.html')));

app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log(`${settings.get('platform_name', 'Platform')} listening on port ${config.port} (${config.env})`);
    if (bootstrap.created) {
      console.log(`Super Admin created: ${bootstrap.email} — it must change its password at first sign-in.`);
    }
    if (!config.isProd) {
      console.log('Development mode: cookies are not marked Secure and HSTS is off. Do not expose this to the internet.');
    }
  });

  const shutdown = (signal) => () => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

module.exports = app;
