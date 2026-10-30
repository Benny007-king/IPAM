# Changelog

Versions follow `major.minor.patch`; each release is tagged `vX.Y.Z`.
Pushing a tag builds, tests and publishes the Windows installer (see `.github/workflows/release.yml`).

## [1.1.0] - 2026-10-30

### Added
- **Any database.** IPAM runs on the built-in SQLite file, **PostgreSQL**, **MySQL / MariaDB** or **Microsoft SQL Server**.
  Settings → Database tests a connection and switches to it, and can copy everything across
  (segments, IPs, users, LDAP servers, AD groups). The previous database is left untouched, and a copy into a
  database that already holds IPAM data is refused. Also configurable with `DATABASE_URL` or `DB_CLIENT`/`DB_HOST`/…
  (the UI then shows it read-only). TLS: off, verified, or any certificate; SQL Server named instances (`server\INSTANCE`).
- **Windows installer** (`IPAM-Setup-<version>.exe`): installs IPAM as the Windows service **IPAM** (starts with
  Windows, restarts on failure, rotating logs), asks for the port, adds an optional firewall rule, keeps data in
  `C:\ProgramData\IPAM` (SYSTEM and Administrators only) and upgrades in place. Running natively also means pings
  leave from the server's own address. A **portable zip** runs `ipam.exe` without installing.
- Release pipeline: a tag builds the exe and installer, installs it on a clean Windows runner, signs in, pings,
  upgrades and uninstalls it, then publishes the release with `SHA256SUMS`.
- `/api/health` (version + live database check), the version in the sidebar, and a Docker `HEALTHCHECK`.

### Changed
- A random session-signing secret is created per install (`DATA_DIR/.jwt-secret`) instead of the built-in default.
  Signed-in users have to sign in once more after upgrading.
- Segments accept a CIDR (`10.0.0.0/24`) or a prefix (`/24`) and are validated; `/31` and `/32` give their addresses.
- Docker image on Node 24 (Node 20 is end-of-life); `npm ci` builds.

### Fixed
- Server errors no longer crash the process (every API route reports errors as JSON; an unreachable database answers 503).
- Notification times were shown hours off (UTC read as local time).
- Editing an LDAP server with the password left blank erased the stored password; LDAP passwords are no longer sent to the browser.
- Settings forms (users, AD groups, LDAP) silently ignored errors such as a duplicate user name.
- Search is case-insensitive on every database; failed sign-ins are throttled (10 per 15 minutes).

## [1.0.0] - 2026-07-19

- First release: segments with auto-populated host addresses, live ping monitoring and offline alerts, global search,
  XLSX/PDF export, local and LDAP/AD sign-in with role mapping, Docker deployment.
