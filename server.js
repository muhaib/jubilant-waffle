require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');

const { initRealtime } = require('./src/realtime');

const app = express();
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({ origin: corsOrigins.length ? corsOrigins : true }));
app.use(express.json());

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/menu', require('./src/routes/menu'));
app.use('/api/tables', require('./src/routes/tables'));
app.use('/api/orders', require('./src/routes/orders'));
app.use('/api/staff', require('./src/routes/staff'));
app.use('/api/reports', require('./src/routes/reports'));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.get(['/master', '/master/*'], (req, res) => res.sendFile(path.join(__dirname, 'public/master/index.html')));
app.get(['/app', '/app/*'], (req, res) => res.sendFile(path.join(__dirname, 'public/app/index.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const httpServer = http.createServer(app);
initRealtime(httpServer, corsOrigins);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Restaurant POS platform listening on port ${PORT}`);
});
