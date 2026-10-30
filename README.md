# IPAM — IP Address Management

A self-hosted **IP Address Management** system for tracking network segments and the IP
addresses inside them. It fills in every host address of a subnet, pings each one every minute
to track online/offline status, raises notifications when a host stays down, and supports
role-based access with local accounts and Active Directory (LDAP).

Data lives in the built-in **SQLite** file or in your own **PostgreSQL**, **MySQL / MariaDB**
or **Microsoft SQL Server**. It runs on Windows as a service, installed and upgraded from one setup file.

**Download:** [latest release](https://github.com/Benny007-king/IPAM/releases/latest) ·
**Changes:** [CHANGELOG.md](CHANGELOG.md)

---

## Features

- **Segments** — define a network as `10.0.0.0/24` (or address + mask); every usable host address is created.
- **IP inventory** — hostname, OS, description, live status and last-seen time per address.
- **Live monitoring** — a background service pings every IP each minute (falling back to the hostname);
  **Refresh** on a segment pings it right away.
- **Notifications** — an alert after 5 minutes offline, then daily; noisy IPs can be muted.
- **Global search** — across segments, IPs, hostnames and OS.
- **Export** — a segment's IPs to **XLSX** or **PDF**.
- **Any database** — SQLite, PostgreSQL, MySQL / MariaDB or SQL Server, switchable from the UI with a full data copy.
- **Access control** — `admin`, `editor`, `readonly`; local accounts (bcrypt) and **LDAP / Active Directory** with AD-group → role mapping.

## Install

IPAM runs on **Windows** as a service, from one setup file. Download **`IPAM-Setup-<version>.exe`** from the
[latest release](https://github.com/Benny007-king/IPAM/releases/latest) and run it.

- Installs IPAM as the Windows service **IPAM** — it starts with Windows and restarts itself on failure.
- Asks which port to use (default **3000**) and can open it in Windows Firewall for other computers.
- Then browse to **http://localhost:3000/** (or `http://<server>:<port>/`).
- Data: `C:\ProgramData\IPAM` (database, connection settings, logs) — readable only by SYSTEM and Administrators.
- Uninstall: *Apps & features → IPAM*. You are asked whether to keep the data.
- Pings leave from the server's own address.

Windows 10 / 11 or Windows Server 2016+, 64-bit. Nothing else is needed — `ipam.exe` contains its runtime.
The setup is not code-signed, so Windows SmartScreen may ask you to confirm (*More info → Run anyway*).
Check the download against `SHA256SUMS` on the release page:

```powershell
Get-FileHash .\IPAM-Setup-1.2.0.exe -Algorithm SHA256
```

**Silent install:** `IPAM-Setup-1.2.0.exe /VERYSILENT /PORT=8080`

## Upgrade

**From the app:** *Settings → Software & Upgrade* → choose the new `IPAM-Setup-x.y.z.exe` → **Upload and check** →
**Install and restart**. The page follows the restart and reloads on the new version; you stay signed in.

Before anything changes, the file is checked: it must be an IPAM setup (by its Windows version information),
not older than the running version (the same version repairs the install), and — when the server can reach
GitHub — byte-for-byte the setup published with that release (its SHA-256 must be in the release's
`SHA256SUMS`; a modified file is refused). The setup then runs outside the IPAM service, and a small watchdog
starts the service again whatever the outcome. Its log is `C:\ProgramData\IPAM\upgrade\install.log`.

**By hand:** run the newer setup on the server. Either way your data, port and firewall setting are kept.

## Development

Needs **Node.js 24**.

```bash
npm install
npm run dev          # http://localhost:3000, with the Vite dev server
```

## First sign-in

| Username | Password   |
|----------|------------|
| `admin`  | `admin123` |

**Change it right away** under **Settings → Local Users**.

## Database

IPAM starts on a built-in SQLite file and can move to a database server at any time:
**Settings → Database → Change database**.

| Engine | Versions | Notes |
|---|---|---|
| SQLite | built in | One file in the data folder. Nothing to set up. |
| PostgreSQL | 12+ | Also Amazon RDS / Aurora, Azure Database for PostgreSQL, Supabase, CockroachDB. |
| MySQL / MariaDB | MySQL 5.7+, MariaDB 10.3+ | |
| Microsoft SQL Server | 2016+, Azure SQL | Named instance: enter `server\INSTANCE` as the server. |

1. Create an empty database and a user that may create tables in it (IPAM creates its own tables).
2. Enter server, port, database, user and password — or paste a connection URL — and pick the TLS mode:
   *Off*, *On — verify the certificate* (a public CA or one in the Windows certificate store), or
   *On — accept any certificate* (self-signed). SQL Server needs SQL authentication and TCP/IP enabled.
3. **Test connection** shows the server version and whether the database already holds IPAM data.
4. **Switch database.** With *Copy my data* ticked, everything (segments, IPs, users, LDAP servers, AD groups)
   is copied first; the target must be empty. Untick it to use an IPAM database that already exists — or an
   empty one, which then gets the default `admin` / `admin123` account.

The current database is never changed or deleted by a switch. The connection is saved in
`<data folder>/database.json`; delete that file to go back to the built-in SQLite database.
If the database is unreachable, IPAM keeps running, reports it (`/api/health` → 503), and reconnects by itself.

To pin the database from outside instead (the UI then shows it read-only), set `DATABASE_URL`
(e.g. `postgres://ipam:secret@db:5432/ipam?sslmode=require`, `mysql://…`, `mssql://…`) or
`DB_CLIENT`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_TLS` — see [.env.example](.env.example).

## Configuration

All optional — environment variables or a `.env` file:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. |
| `DATA_DIR` | `C:\ProgramData\IPAM` (installed) · the working directory (development) | Database file, `database.json`, session secret, upgrade files. |
| `DB_PATH` | `<DATA_DIR>/ipam.db` | Location of the SQLite file. |
| `DATABASE_URL` / `DB_*` | — | Pin an external database (see above). |
| `JWT_SECRET` | random, saved as `<DATA_DIR>/.jwt-secret` | Session signing secret. Set only to share sessions between servers. |
| `COOKIE_SECURE` | `false` | `true` only when IPAM is served over HTTPS. |

## Roles

| Role | Permissions |
|---|---|
| `admin` | Everything — segments, IPs, users, LDAP servers, AD groups, database |
| `editor` | Edit IP details within existing segments |
| `readonly` | View segments and IPs |

## LDAP / Active Directory

Add one or more domain controllers under **Settings → LDAP Configuration**, then map AD groups to roles under
**AD Groups Permissions**. At sign-in, a user's group membership resolves to the highest matching role.
**Test Connection** checks the service account (when editing, a blank password re-uses the stored one).

## Building the Windows release

Needs Windows, Node.js 24 and [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```bash
npm ci
npm run build:exe                                   # release/ipam/ipam.exe (+ SQLite engine, nssm)
iscc /DAppVersion=1.2.0 installer\ipam.iss          # release/IPAM-Setup-1.2.0.exe
```

`build:exe` bundles the server with esbuild, wraps it with Node in `ipam.exe` (`@yao-pkg/pkg`) and places the
SQLite engine (`better_sqlite3.node`) and `nssm.exe` (service wrapper, public domain) beside it.

**Releases are automatic:** bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, and push a tag
`vX.Y.Z`. [The workflow](.github/workflows/release.yml) builds the exe and installer, installs them on a clean Windows
runner (service, sign-in, live ping, upgrade by setup and from the app, uninstall), and publishes the release
with `SHA256SUMS`. A release ships one file: `IPAM-Setup-x.y.z.exe`.

## Project structure

```
server.ts                 Express API: auth, LDAP, segments/IPs, settings, health
db.ts                     Database layer (Knex): config, schema, switching + data copy
paths.ts                  Data folder, version, packaged-exe detection
pingService.ts            Background ping + offline notifications
upgrade.ts                Settings > Software & Upgrade: check an uploaded setup, run it outside the service
src/                      React UI (App.tsx, SettingsView.tsx, SoftwareSettings.tsx, DatabaseSettings.tsx)
scripts/build-exe.mjs     Builds ipam.exe (the installer wraps it)
scripts/test-installer.ps1  Installer smoke test (CI only - installs a service)
installer/ipam.iss        Inno Setup script; installer/nssm.exe service wrapper
.github/workflows/        Release pipeline
```

## License

[MIT](LICENSE)
