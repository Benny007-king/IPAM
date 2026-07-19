# IPAM — IP Address Management

A self-hosted **IP Address Management** system for tracking network segments and the IP
addresses inside them. It auto-populates every host address in a subnet, continuously pings
each one to track online/offline status, raises notifications when a host stays down, and
supports role-based access with both local accounts and Active Directory (LDAP) authentication.

Built with **React 19 + Vite + TypeScript** on the front end and an **Express + better-sqlite3**
API on the back end, packaged to run as a Windows service behind IIS.

---

## Features

- **Segments** — define networks by `network + subnet mask`; all usable host IPs are generated automatically.
- **IP inventory** — per-IP hostname, OS, description, live status and last-seen timestamp.
- **Live monitoring** — a background service pings every IP each minute (falling back to hostname).
- **Notifications** — alerts when an IP has been offline for 5 minutes, then escalating daily; IPs can be muted.
- **Global search** — search across segments, IPs, hostnames and OS.
- **Export** — export a segment's IPs to **XLSX** or **PDF**.
- **Access control** — three roles: `admin`, `editor`, `readonly`.
- **Authentication** — local accounts (bcrypt-hashed) and **LDAP / Active Directory** with AD-group → role mapping.

## Tech stack

| Layer      | Technology                                             |
|------------|--------------------------------------------------------|
| Frontend   | React 19, Vite 6, Tailwind CSS 4, lucide-react         |
| Backend    | Node.js, Express 4, TypeScript (run via `tsx`)         |
| Database   | SQLite via `better-sqlite3` (WAL mode)                 |
| Auth       | JWT (httpOnly cookie), bcryptjs, `ldapts`              |
| Monitoring | `ping`, `date-fns`                                     |
| Export     | `xlsx`, `jspdf` + `jspdf-autotable`                    |

## Getting started

### Prerequisites
- **Node.js** (v20+ recommended; the bundled installer ships v24)

### Run locally (development)

```bash
npm install
npm run dev
```

The server starts on **http://localhost:3000** (Vite runs in middleware mode, so the API and
the UI are served from the same port).

### Build & run in production

```bash
npm run build           # builds the frontend into dist/
set NODE_ENV=production  # (Windows) so the server serves dist/ statically
npx tsx server.ts
```

### First login

A default local admin is created automatically on first run:

| Username | Password   |
|----------|------------|
| `admin`  | `admin123` |

> **Change this password immediately** from **Settings → Local Users** after your first login.

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable        | Default          | Description                                                                            |
|-----------------|------------------|----------------------------------------------------------------------------------------|
| `JWT_SECRET`    | *(dev fallback)* | Secret used to sign auth tokens. **Set a long random value in production.**            |
| `PORT`          | `3000`           | Port the server listens on.                                                            |
| `COOKIE_SECURE` | `false`          | Set `true` **only** when serving over HTTPS. Leave `false` for plain-HTTP / IIS proxy. |

## Roles

| Role       | Permissions                                                        |
|------------|--------------------------------------------------------------------|
| `admin`    | Full access — manage segments, IPs, users, LDAP servers, AD groups |
| `editor`   | Add/edit IP details within existing segments                       |
| `readonly` | View segments and IPs only                                         |

## LDAP / Active Directory

Configure one or more domain controllers under **Settings → LDAP Configuration** (admin only),
then map AD groups to IPAM roles under **AD Groups Permissions**. On login, a user's AD group
membership is resolved to the highest matching role. Use **Test Connection** to validate the
service-account credentials before saving.

## Docker

The fastest way to run IPAM is with the included `docker-compose.yml`:

```bash
docker compose up -d --build
```

This gives you a container named **`ipam`** (not a random name), a persisted database, and
**host networking** so monitoring works correctly. It serves on port 3000 in production mode.

### Why host networking? (ping source IP)

The ping service must reach every device on your LAN, and monitored devices should see the ping
coming from the host — not from Docker. On a default **bridge** network the container sits on an
isolated `172.x` subnet and its traffic is NAT'd, so devices see the Docker gateway / host NAT
and same-subnet devices may be unreachable. `network_mode: host` (set in the compose file) makes
the container share the host's network stack, so pings originate from the host's real IP and
interfaces. **Host networking is Linux-only** — on Windows/macOS Docker Desktop, run IPAM as a
native process / Windows service instead (see below).

> The image installs `iputils-ping`, which the monitoring service shells out to.

### Plain `docker run`

If you prefer not to use compose, pass `--name` so the container isn't given a random name, and
`--network host` so pings come from the host:

```bash
docker build -t ipam .
docker run -d --name ipam --network host \
  -e JWT_SECRET="your-long-random-secret" \
  -e DB_PATH="/app/data/ipam.db" \
  -v ipam-data:/app/data \
  ipam
```

## Deployment on Windows (IIS + service)

The repo includes helper scripts for a Windows deployment:

- `build_frontend.bat` — installs dependencies and builds the frontend.
- `start_server.bat` — starts the server in production mode.
- `web.config` — IIS reverse-proxy rule (URL Rewrite + Application Request Routing) forwarding to `http://localhost:3000`.
- `nssm.exe` *(not committed)* — used to install the Node server as a Windows service.

> The IIS proxy forwards over plain **HTTP**, so keep `COOKIE_SECURE=false` unless you terminate TLS.

## Project structure

```
server.ts          Express API, auth, LDAP, segment/IP routes
database.ts        SQLite schema, migrations, default admin seed
pingService.ts     Background ping + offline-notification loop
index.html         Vite entry
src/
  App.tsx          Main app: login, dashboard, segments, IPs
  SettingsView.tsx Users / LDAP / AD-group management
  components/ui/   Button, Input primitives
  types.ts         Shared TypeScript types
```

## Notes

- `ipam.db` (the SQLite database) and large deploy binaries/installers are git-ignored and are
  created/downloaded per environment rather than committed.
- Data files use SQLite WAL mode (`ipam.db-wal` / `ipam.db-shm`).

## License

Internal / private project.
