# Restaurant POS Platform

A multi-tenant point-of-sale system for restaurants, with a master admin
panel that provisions new restaurant clients, and real-time order/kitchen
sync for each one.

## What's in here

- **Master admin panel** (`/master`) — a platform owner's console: create new
  restaurant clients, generate their first owner login, suspend/reactivate
  accounts, and see platform-wide stats.
- **Restaurant app** (`/app`) — everything one restaurant needs, scoped to
  that restaurant only:
  - **POS** — build an order from the menu, per table or takeaway/delivery
  - **Active orders** — live board of open orders, billing, payment collection
  - **Kitchen display (KDS)** — real-time pending → preparing → ready → served
    board for the kitchen
  - **Tables** — free / occupied / reserved status
  - **Menu** — categories and items, pricing, descriptions, availability
    toggle, uploaded photos, and size modifiers (e.g. Small/Medium/Large,
    each with its own price — the POS asks which one when an item has any)
  - **Staff** — manager/cashier/waiter/kitchen accounts for that restaurant
  - **Reports** — daily sales, top items, revenue by payment method
- **Real-time sync** via Socket.IO: an order placed on one device shows up
  instantly on the kitchen display and the orders board, no refresh needed.

Every restaurant's data (menu, tables, orders, staff) is isolated by
`restaurant_id` at the database and API layer — one tenant can never read or
modify another's data, enforced server-side, not just hidden in the UI.

## Roles

| Role | Access |
|---|---|
| `super_admin` | Master admin panel only — creates/manages restaurants |
| `owner` | Full access to their restaurant's app |
| `manager` | Same as owner, minus nothing — full operational access |
| `cashier` / `waiter` | POS, active orders, tables |
| `kitchen` | Kitchen display only |

## Running it locally

```bash
npm install
cp .env.example .env      # edit JWT_SECRET and super-admin credentials
npm start                 # http://localhost:3000
```

The first time the server starts it creates the super-admin account from
`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` in `.env`. Log in there, then use
**+ New restaurant** in the master panel to create your first tenant.

Want to explore without doing that by hand? `npm run seed` adds a demo
restaurant ("Demo Bistro") with a menu, tables, and an owner login printed to
the console.

## Tests

```bash
npm test
```

Runs the API test suite (`node --test`) covering auth, tenant isolation, and
the full order → kitchen → payment lifecycle. No external services needed —
each run spins up the server against a throwaway SQLite file.

## Tech stack

- **Backend**: Node.js, Express, `better-sqlite3` (file-based SQL database,
  zero external DB server to run), JWT auth, Socket.IO for real-time events
- **Frontend**: plain HTML/CSS/JavaScript served as static files — no build
  step, no framework, nothing to compile before deploying
- **Deployment**: designed for a Hostinger VPS behind Nginx with PM2 process
  management — see [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full walkthrough

## Project layout

```
server.js              # entrypoint: Express app + HTTP server + Socket.IO
src/db.js               # SQLite schema + super-admin bootstrap
src/auth.js              # JWT signing/verification, role + tenant-scoping middleware
src/realtime.js          # Socket.IO setup, per-restaurant rooms
src/routes/               # auth, admin (master panel), menu, tables, orders, staff, reports
src/seed.js               # optional demo data
public/                   # static frontend: login, /master, /app
test/api.test.js          # API test suite
ecosystem.config.js       # PM2 config for the VPS
nginx.conf.example        # reverse proxy config with WebSocket upgrade headers
DEPLOYMENT.md              # step-by-step Hostinger VPS deployment guide
```
