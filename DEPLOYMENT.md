# Deploying to Hostinger

This app is a single Node.js process (Express + Socket.IO + a SQLite file). It
needs a host that keeps a Node process running persistently and can proxy
WebSocket upgrades — that means a **Hostinger VPS**, not shared web hosting.
(Hostinger's shared-hosting "Node.js" feature runs apps behind Phusion
Passenger, which does not reliably support WebSocket upgrades, so real-time
kitchen/order updates would silently fall back to slow polling or break. Use
the VPS path below for a proper deployment.)

## 1. Provision the VPS

1. In hPanel, buy a **VPS** plan (KVM 1 or 2 is enough for one to a few dozen
   restaurants; scale up as tenants grow).
2. Choose the **Ubuntu 22.04** OS template (or the Node.js template if offered
   — either works, we install Node ourselves below to control the version).
3. Point your domain's DNS at the VPS: in hPanel → Domains → DNS, add an
   **A record** for `pos.yourdomain.com` → your VPS's IPv4 address.
4. SSH in: `ssh root@your-vps-ip`

## 2. Install Node.js, PM2 and Nginx

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm install -g pm2
node -v   # confirm v20+
```

## 3. Get the code onto the server

```bash
sudo mkdir -p /var/www/restaurant-pos
sudo chown $USER:$USER /var/www/restaurant-pos
git clone <your-repo-url> /var/www/restaurant-pos
cd /var/www/restaurant-pos
npm install --omit=dev
```

(`better-sqlite3` compiles a small native module on install — the VPS needs
`build-essential` if a prebuilt binary isn't available for your architecture:
`sudo apt-get install -y build-essential python3`.)

## 4. Configure environment variables

```bash
cp .env.example .env
nano .env
```

Set at minimum:
- `JWT_SECRET` — generate with `openssl rand -hex 32`
- `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` — your master admin login
  (created automatically the first time the server starts)
- `DB_PATH` — leave as `./data/pos.db`, or point it somewhere with more disk
- `CORS_ORIGINS` — leave blank; the app is same-origin behind Nginx

## 5. Start the app under PM2

```bash
mkdir -p logs
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup   # follow the printed command to enable boot-time startup
```

Check it's alive: `curl http://127.0.0.1:3000/healthz` → `{"ok":true}`

## 6. Put Nginx in front of it (with HTTPS)

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/restaurant-pos
sudo nano /etc/nginx/sites-available/restaurant-pos   # set your real domain
sudo ln -s /etc/nginx/sites-available/restaurant-pos /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d pos.yourdomain.com
```

Certbot rewrites the Nginx config to add a 443 server block and auto-renews
the certificate via a systemd timer — no further action needed.

Visit `https://pos.yourdomain.com` — you should see the login screen.

## 7. First login and creating restaurant clients

1. Log in with the `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` from your
   `.env`. You land on `/master`, the platform dashboard.
2. Click **+ New restaurant**, fill in the restaurant's name and its owner's
   name/email. The panel shows a one-time temporary password — send that to
   the restaurant owner.
3. The owner logs in at the same URL; the app detects their role and sends
   them to `/app` (POS, kitchen display, menu, tables, staff, reports)
   instead of the master panel.
4. Repeat step 2 for every new restaurant client — each one is fully isolated
   (separate menu, tables, orders, staff) inside the same deployment.

## Updating the app

```bash
cd /var/www/restaurant-pos
git pull
npm install --omit=dev
pm2 restart restaurant-pos
```

## Backups

Platform data lives in two places: the SQLite file (`data/pos.db` by
default, plus its WAL sidecar files) and uploaded menu-item photos
(`public/uploads/`). Back up both on a cron schedule:

```bash
# /etc/cron.d/restaurant-pos-backup
0 3 * * * root sqlite3 /var/www/restaurant-pos/data/pos.db ".backup /var/backups/pos-$(date +\%F).db"
0 3 * * * root tar -czf /var/backups/pos-uploads-$(date +\%F).tar.gz -C /var/www/restaurant-pos public/uploads
```

Prune old backups periodically or ship them off-server (Hostinger's object
storage, S3, etc.) for real disaster recovery.

## Scaling notes

- One VPS comfortably serves many small-to-mid restaurants on a single SQLite
  file; SQLite handles concurrent reads well and writes are short-lived
  per-order transactions.
- If you outgrow a single file (very high write concurrency, need for
  read replicas, multi-region), swap `better-sqlite3` in `src/db.js` for a
  Postgres/MySQL client — the query shapes are plain SQL and port directly.
  Hostinger VPS plans include the ability to run MySQL/PostgreSQL locally, or
  you can point at Hostinger's managed database add-on.
- Keep PM2 `instances: 1` unless you add a Redis adapter for Socket.IO
  (`@socket.io/redis-adapter`) — otherwise real-time events won't fan out
  correctly across multiple Node processes.
- Put a second, larger VPS in front as a load balancer only once a single
  instance is actually CPU/RAM constrained (`pm2 monit` to check).
