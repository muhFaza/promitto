# Promitto

*I send forth, I promise.*

A self-hosted WhatsApp message scheduler. Pair your number via QR, build a local contact list, and schedule one-time or recurring text messages.

Not a SaaS. No public signup. Accounts are provisioned by a superuser. Designed for the operator plus a handful of trusted users on a single VPS.

## Stack

- Backend: Node 20 LTS, Express 4 + TypeScript, SQLite via Drizzle ORM, Baileys
- Frontend: Vite + React 18 + TypeScript + Tailwind, React Router v6, Zustand, PWA
- Dev + Prod: Docker Compose, Traefik v3.2 reverse proxy

---

## Dev setup

Everything runs in Docker. You don't need Node on the host.

```bash
cp backend/.env.example backend/.env
docker compose up --build
```

- Backend → http://localhost:3000
- Frontend → http://localhost:5173

Health check:

```bash
curl http://localhost:3000/api/health
```

### Common commands

```bash
# generate drizzle migration after schema changes
docker compose exec backend npm run db:generate

# apply migrations
docker compose exec backend npm run db:migrate

# typecheck / lint
docker compose exec backend npm run typecheck
docker compose exec backend npm run lint
docker compose exec frontend npm run typecheck
docker compose exec frontend npm run lint
```

### First superuser

Interactive (requires a TTY):

```bash
docker compose exec backend npm run cli:create-superuser
docker compose exec backend npm run cli:reset-superuser-password
```

If you forget the superuser password, SSH into the VPS and run the reset command. There is no email, no recovery link, and no web form. This is intentional.

---

## Production deployment

Promitto runs as a single container behind [Traefik](https://traefik.io/) on the shared `web` Docker network. The container binds to port 3000; Traefik terminates TLS and forwards traffic.

### 1. Prerequisites

- Docker + Docker Compose v2 installed on the VPS
- A Traefik instance running with:
  - The `web` external Docker network
  - HTTPS entrypoint named `websecure` + an ACME certresolver named `le`
  - Port 80 reachable for HTTP-01 challenge
- DNS A record for your subdomain (e.g. `wa.muhfaza.my.id`) pointing at the VPS

(This repo's sibling `~/traefik` project already provides all of the above.)

### 2. Configure secrets

```bash
cp .env.production.example .env
# Generate a strong SESSION_SECRET
openssl rand -base64 48
# Paste the output into SESSION_SECRET= in .env
```

`SESSION_SECRET` must be at least 32 characters. **Rotating it invalidates all existing sessions**, by design.

### 3. Build and start

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The entrypoint applies any pending migrations, then starts the server. Traefik will pick up the container via labels and request a Let's Encrypt cert on first HTTPS hit.

Verify:

```bash
curl https://wa.muhfaza.my.id/api/health
# {"status":"ok","db":"ok","sessions":0}
```

### 4. Create the first superuser

```bash
docker compose -f docker-compose.prod.yml exec promitto \
  node dist/cli/create-superuser.js
```

Since the CLI uses interactive prompts, run it from a terminal with a TTY (plain SSH is fine — avoid non-interactive shells).

Then sign in at `https://wa.muhfaza.my.id/login`.

### Traefik labels — what they do

| Label | Purpose |
|---|---|
| `traefik.enable=true` | opt into Traefik routing |
| `traefik.docker.network=web` | use the shared network |
| `Host(\`wa.muhfaza.my.id\`)` | domain rule |
| `entrypoints=websecure` | HTTPS only (HTTP redirects via your Traefik config) |
| `tls.certresolver=le` | ACME issuer name in your Traefik config |
| `loadbalancer.server.port=3000` | container port |
| `promitto-hsts` middleware | HSTS response header |

Change the `Host(...)` rule to match your own domain.

### Single instance only

The scheduler poller and the Baileys `SessionManager` are process-singletons. **Do not run multiple replicas.** Horizontal scaling would cause double-sends and socket fights. If you ever outgrow one VPS, the rewrite is Redis + BullMQ + leader election — don't paper over it.

---

## Backup & restore

Everything that matters lives in `backend/data/`: the SQLite DB and every user's Baileys auth state.

**Backup** (from the repo root):

```bash
./deploy/backup.sh                              # writes to ~/promitto-backups
./deploy/backup.sh /path/to/my/snapshots        # custom destination
```

Schedule via cron:

```cron
15 3 * * *  cd /home/fazadev/promitto && ./deploy/backup.sh >> /home/fazadev/promitto-backups/backup.log 2>&1
```

**Restore** onto a fresh VPS:

```bash
docker compose -f docker-compose.prod.yml down
# extract so that backend/data/ is restored
tar -xzf promitto-data-<ts>.tar.gz -C backend/
docker compose -f docker-compose.prod.yml up -d
```

Losing `backend/data/sessions/{userId}/` means that user has to pair WhatsApp again. Losing `promitto.db` means losing all accounts, contacts, and schedules — back it up.

---

## Upgrade procedure

The canonical flow:

```bash
cd /home/fazadev/promitto
./deploy/backup.sh                                        # snapshot first
git pull
docker compose -f docker-compose.prod.yml up -d --build   # rebuild + restart
docker compose -f docker-compose.prod.yml logs -f promitto | head
```

The entrypoint runs `db:migrate` before the server starts, so pending migrations apply automatically. Migrations must always be backward-safe with the previous code in case of a quick rollback.

To roll back, check out the previous tag/commit, then `docker compose -f docker-compose.prod.yml up -d --build`. If a migration was incompatible, restore `backend/data/` from the latest backup.

---

## Superuser

The first superuser is created via CLI. There is no UI to create or reset a superuser, by design.

Dev:

```bash
docker compose exec backend npm run cli:create-superuser
docker compose exec backend npm run cli:reset-superuser-password
```

Prod:

```bash
docker compose -f docker-compose.prod.yml exec promitto node dist/cli/create-superuser.js
docker compose -f docker-compose.prod.yml exec promitto node dist/cli/reset-superuser-password.js
```

---

## Scope (unchanged, do not expand)

- Text messages only (no media)
- One WhatsApp number per user
- Admin-provisioned users, no `/signup` route
- Per-user IANA timezone
- Compose-time warnings when 10+ pending messages or creating a recurring schedule
- No hard send caps — warnings only

## License

See `LICENSE`.
