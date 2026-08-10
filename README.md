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

`docker-compose.prod.yml` has **no `build:` key** — it references a prebuilt `promitto:deploy` image. The VPS has ~960MB of RAM and Node builds have been OOM-killed on it, so images are always built elsewhere and shipped in.

Normally CI does this for you (see [Automatic deployment](#automatic-deployment)). To do it by hand from a workstation:

```bash
# --platform matters if you're on Apple Silicon; the VPS is x86_64
docker buildx build --platform linux/amd64 -t promitto:deploy --load .
docker save promitto:deploy | gzip -1 | ssh -i ssh1.pem fazadev@<vps> 'gunzip | docker load'
ssh -i ssh1.pem fazadev@<vps> 'cd promitto && docker compose -f docker-compose.prod.yml up -d'
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

**There is no automatic backup.** No cron, and the deploy workflow does not snapshot before restarting — this is a deliberate choice, not an oversight. `backup.sh` is a manual tool; run it yourself when you want a snapshot.

The consequence to keep in mind: a rollback restores the *image*, never the *schema*. If a migration turns out to be destructive or incompatible, there is nothing to restore from. That is the whole reason migrations must stay backward-compatible with the previous release.

**Restore** onto a fresh VPS:

```bash
docker compose -f docker-compose.prod.yml down
# extract so that backend/data/ is restored
tar -xzf promitto-data-<ts>.tar.gz -C backend/
docker compose -f docker-compose.prod.yml up -d
```

Losing `backend/data/sessions/{userId}/` means that user has to pair WhatsApp again. Losing `promitto.db` means losing all accounts, contacts, and schedules — back it up.

---

## Automatic deployment

Every push to `main` that touches something other than Markdown runs `.github/workflows/deploy.yml`, which:

1. builds the image on the runner (native `linux/amd64` — the VPS never builds),
2. rotates the current `promitto:deploy` to `promitto:previous` as a rollback target,
3. streams the new image over SSH (`docker save | gzip | docker load`),
4. copies `docker-compose.prod.yml` across — deliberately *not* a VPS-side `git pull`, which has silently served a stale ref on this box before,
5. runs `docker compose up -d`,
6. polls `/api/health` for up to 150s, and **rolls back to `promitto:previous` if it never goes green**.

It does **not** take a backup first. See [Backup & restore](#backup--restore).

`workflow_dispatch` is enabled, so you can also deploy the current `main` by hand from the Actions tab.

Required repo secrets: `VPS_SSH_KEY` (private key with access to `fazadev@<vps>`) and `VPS_KNOWN_HOSTS` (pinned host key, so the deploy never blind-trusts a keyscan).

**Each deploy restarts the container, which drops any live WhatsApp socket.** Sessions restore automatically from `backend/data/sessions/`, but a session that fails to restore needs a QR re-pair from the phone. Batch your merges accordingly.

### Manual rollback

```bash
ssh -i ssh1.pem fazadev@<vps> 'cd promitto \
  && docker tag promitto:previous promitto:deploy \
  && docker compose -f docker-compose.prod.yml up -d'
```

The entrypoint runs `db:migrate` before the server starts, so pending migrations apply automatically. Migrations must always be backward-safe with the previous code — rolling the image back does **not** roll the schema back, and with no backups there is nothing to restore from. An incompatible migration is unrecoverable, so review schema changes accordingly.


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
