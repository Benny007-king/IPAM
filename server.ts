import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Client } from 'ldapts';
import {
  db,
  DbError,
  explainDbError,
  getStatus,
  initDatabase,
  insertId,
  ipToLong,
  isConnectionError,
  isUniqueViolation,
  pingDatabase,
  normalizeConfig,
  nowIso,
  switchDatabase,
  testConnection,
  withStoredPassword,
} from './db.js';
import { refreshSegment, startPingService } from './pingService.js';
import { cleanupAfterUpgrade, discardPending, installPending, receiveUpload, systemInfo, UpgradeError } from './upgrade.js';
import { appRoot, appVersion, dataDir, isPackaged, writeFileAtomic } from './paths.js';

const PORT = Number(process.env.PORT) || 3000;
const ROLES = ['admin', 'editor', 'readonly'] as const;

/* ------------------------------------------------------------------------- */
/* Session signing secret                                                    */
/* ------------------------------------------------------------------------- */

// JWT_SECRET from the environment wins; otherwise a random secret is created
// once and kept in the data folder, so every install has its own.
function loadJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, '.jwt-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* first run */
  }
  const secret = crypto.randomBytes(48).toString('hex');
  writeFileAtomic(file, secret);
  return secret;
}
const JWT_SECRET = loadJwtSecret();

// Plain HTTP is the common case (a LAN service or behind IIS), and a `secure`
// cookie would never be sent over it. Set COOKIE_SECURE=true when serving HTTPS.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: COOKIE_SECURE,
  sameSite: (COOKIE_SECURE ? 'none' : 'lax') as 'none' | 'lax',
  maxAge: 24 * 60 * 60 * 1000, // 1 day, matches JWT expiry
};

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

type Handler = (req: any, res: Response, next: NextFunction) => Promise<unknown> | unknown;
/** Express 4 does not catch errors from async handlers; route them to the error middleware. */
const ah = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Escape values interpolated into LDAP search filters (RFC 4515).
function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const longToIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Accept "255.255.255.0", "/24" or "24"; reject non-contiguous masks. */
function normalizeMask(input: string): string | null {
  const t = String(input || '').trim().replace(/^\//, '');
  if (/^\d{1,2}$/.test(t)) {
    const bits = Number(t);
    if (bits > 32) return null;
    return longToIp(bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);
  }
  if (!IPV4.test(t)) return null;
  const inverted = ~ipToLong(t) >>> 0;
  return (inverted & (inverted + 1)) === 0 ? t : null;
}

/** Validate a segment body; the network may also be written as "10.0.0.0/24". */
function parseSegment(body: any) {
  const name = String(body?.name || '').trim();
  let network = String(body?.network || '').trim();
  let mask = String(body?.subnet_mask || '').trim();
  if (network.includes('/')) {
    const [addr, bits] = network.split('/');
    network = addr.trim();
    if (!mask) mask = bits;
  }
  if (!name) throw new HttpError(400, 'Enter a segment name.');
  if (!IPV4.test(network)) throw new HttpError(400, 'The network must be an IPv4 address such as 192.168.1.0.');
  const subnet = normalizeMask(mask);
  if (!subnet) throw new HttpError(400, 'The subnet mask must look like 255.255.255.0 or /24.');
  const base = longToIp((ipToLong(network) & ipToLong(subnet)) >>> 0);
  return { name, network: base, subnet_mask: subnet, description: body?.description ? String(body.description) : null };
}

/** Every usable host address of a subnet (all addresses for /31 and /32), capped at 65,534. */
function hostAddresses(network: string, mask: string): string[] {
  const maskLong = ipToLong(mask);
  const net = (ipToLong(network) & maskLong) >>> 0;
  const broadcast = (net | (~maskLong >>> 0)) >>> 0;
  const [first, last] = broadcast - net + 1 <= 2 ? [net, broadcast] : [net + 1, broadcast - 1];
  const count = Math.min(last - first + 1, 65534);
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(longToIp(first + i));
  return out;
}

/** Bring a segment's IP rows in line with its subnet. Runs in the background. */
async function syncIpsForSegment(segmentId: number, network: string, mask: string) {
  const valid = new Set(hostAddresses(network, mask));
  const existing = await db('ips').select('id', 'ip_address').where({ segment_id: segmentId });
  const have = new Set(existing.map((r: any) => r.ip_address));
  const toDelete = existing.filter((r: any) => !valid.has(r.ip_address)).map((r: any) => r.id);
  const toAdd = [...valid].filter((ip) => !have.has(ip));

  for (let i = 0; i < toDelete.length; i += 500) {
    await db('ips').whereIn('id', toDelete.slice(i, i + 500)).del();
  }
  const created = nowIso();
  const rows = toAdd.map((ip) => ({
    segment_id: segmentId,
    ip_address: ip,
    ip_long: ipToLong(ip),
    status: 'unknown',
    created_at: created,
    notification_count: 0,
    mute_notifications: 0,
  }));
  // 250 rows x 7 values stays under SQL Server's 2100-parameter limit.
  for (let i = 0; i < rows.length; i += 250) {
    await db('ips').insert(rows.slice(i, i + 250));
  }
}

function syncInBackground(segmentId: number, network: string, mask: string) {
  syncIpsForSegment(segmentId, network, mask).catch((e) =>
    console.error(`Failed to sync IPs for segment ${segmentId}: ${explainDbError(e)}`),
  );
}

function requireRoleValue(role: unknown) {
  if (!ROLES.includes(role as any)) throw new HttpError(400, 'Role must be admin, editor or readonly.');
  return role as string;
}

/* ------------------------------------------------------------------------- */
/* Login throttling                                                          */
/* ------------------------------------------------------------------------- */

const failedLogins = new Map<string, { count: number; first: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function loginKey(req: Request, username: string) {
  return `${req.ip}|${username.toLowerCase()}`;
}
function loginBlocked(key: string) {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}
function recordFailure(key: string) {
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) failedLogins.set(key, { count: 1, first: Date.now() });
  else entry.count++;
}

/* ------------------------------------------------------------------------- */
/* Server                                                                    */
/* ------------------------------------------------------------------------- */

async function startServer() {
  await initDatabase();
  try {
    cleanupAfterUpgrade();
  } catch (e: any) {
    console.error('Upgrade clean-up failed:', e?.message || e);
  }

  const app = express();
  const isProd = process.env.NODE_ENV === 'production' || isPackaged;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (isProd) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
          "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
    }
    next();
  });

  startPingService();

  const requireAuth = (req: any, res: Response, next: NextFunction) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  };

  const requireRole = (roles: string[]) => (req: any, res: Response, next: NextFunction) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };

  const issueSession = (res: Response, user: { id: number; username: string; role: string }) => {
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
    res.cookie('token', token, COOKIE_OPTIONS);
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  };

  /* ---------------- health ---------------- */

  app.get(
    '/api/health',
    ah(async (_req, res) => {
      const up = await pingDatabase();
      res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'degraded', version: appVersion, database: up });
    }),
  );

  /* ---------------- auth ---------------- */

  app.post(
    '/api/auth/login',
    ah(async (req, res) => {
      const { password, type } = req.body || {};
      const username = String(req.body?.username || '').trim();
      if (!username || !password) throw new HttpError(400, 'Enter a user name and password.');
      const key = loginKey(req, username);
      if (loginBlocked(key)) throw new HttpError(429, 'Too many failed sign-ins. Try again in 15 minutes.');

      if (type === 'local') {
        const user = await db('users').where({ username, is_local: 1 }).first();
        if (!user || !user.password_hash || !bcrypt.compareSync(String(password), user.password_hash)) {
          recordFailure(key);
          throw new HttpError(401, 'Invalid credentials');
        }
        failedLogins.delete(key);
        return issueSession(res, user);
      }

      // LDAP / Active Directory
      const ldapServers = await db('ldap_servers').select('*');
      if (ldapServers.length === 0) throw new HttpError(400, 'No LDAP servers configured');
      const adGroups = await db('ad_groups').select('*');
      if (adGroups.length === 0) throw new HttpError(400, 'No AD groups configured for access');

      let authenticated = false;
      let userGroups: string[] = [];
      let lastError: unknown = null;
      const sAMAccountName = escapeLdapFilter(username.split('@')[0].split('\\').pop() || '');

      for (const server of ldapServers) {
        const addresses = String(server.dc_addresses).split(',').map((a) => a.trim()).filter(Boolean);
        for (const address of addresses) {
          const url = `ldap://${address}:${server.port}`;
          const client = new Client({ url, timeout: 5000, connectTimeout: 5000 });
          try {
            await client.bind(server.service_account, server.password);
            const rootDse = await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['defaultNamingContext'] });
            const searchBase = rootDse.searchEntries[0].defaultNamingContext as string;
            const found = await client.search(searchBase, {
              scope: 'sub',
              filter: `(&(objectClass=user)(sAMAccountName=${sAMAccountName}))`,
              attributes: ['dn', 'memberOf'],
            });
            if (found.searchEntries.length === 0) throw new Error('User not found in AD');
            const entry = found.searchEntries[0];

            const userClient = new Client({ url, timeout: 5000, connectTimeout: 5000 });
            await userClient.bind(entry.dn, String(password));
            await userClient.unbind();

            const memberOf = entry.memberOf;
            const list = Array.isArray(memberOf) ? memberOf : memberOf ? [memberOf] : [];
            userGroups = list.map((g: any) => {
              const s = g.toString();
              return s.match(/CN=([^,]+)/i)?.[1] ?? s;
            });
            authenticated = true;
            await client.unbind();
            break;
          } catch (err) {
            lastError = err;
            try {
              await client.unbind();
            } catch {
              /* ignore */
            }
          }
        }
        if (authenticated) break;
      }

      if (!authenticated) {
        recordFailure(key);
        console.error('LDAP Auth failed:', (lastError as any)?.message || lastError);
        throw new HttpError(401, 'Invalid LDAP credentials or user not found');
      }

      const rank: Record<string, number> = { admin: 3, editor: 2, readonly: 1 };
      let assignedRole = '';
      for (const group of userGroups) {
        const match = adGroups.find((ag: any) => String(ag.group_name).toLowerCase() === group.toLowerCase());
        if (match && (rank[match.role] || 0) > (rank[assignedRole] || 0)) assignedRole = match.role;
      }
      if (!assignedRole) throw new HttpError(403, 'User does not belong to any authorized AD group');
      failedLogins.delete(key);

      let user = await db('users').where({ username }).first();
      if (!user) {
        const id = await insertId(db, 'users', { username, role: assignedRole, is_local: 0 });
        user = { id, username, role: assignedRole };
      } else if (user.role !== assignedRole) {
        await db('users').where({ id: user.id }).update({ role: assignedRole });
        user.role = assignedRole;
      }
      issueSession(res, user);
    }),
  );

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: COOKIE_SECURE, sameSite: COOKIE_OPTIONS.sameSite });
    res.json({ success: true });
  });

  app.get('/api/auth/me', requireAuth, (req: any, res) => {
    res.json({ user: req.user, version: appVersion });
  });

  /* ---------------- search ---------------- */

  app.get(
    '/api/search',
    requireAuth,
    ah(async (req, res) => {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ segments: [], ips: [] });
      const term = `%${q.toLowerCase()}%`;
      const anyLike = (columns: string[]) => (qb: any) => {
        for (const c of columns) qb.orWhereRaw('lower(??) like ?', [c, term]);
      };
      const segments = await db('segments').where(anyLike(['name', 'network', 'subnet_mask', 'description'])).orderBy('name');
      const ips = await db('ips')
        .join('segments', 'ips.segment_id', 'segments.id')
        .select('ips.*', 'segments.name as segment_name')
        .where(anyLike(['ips.ip_address', 'ips.hostname', 'ips.os', 'ips.description']))
        .orderBy('ips.ip_long')
        .limit(50);
      res.json({ segments, ips });
    }),
  );

  /* ---------------- segments ---------------- */

  app.get(
    '/api/segments',
    requireAuth,
    ah(async (_req, res) => {
      res.json(await db('segments').select('*').orderBy('id'));
    }),
  );

  app.get(
    '/api/segments/:id',
    requireAuth,
    ah(async (req, res) => {
      const segment = await db('segments').where({ id: Number(req.params.id) }).first();
      if (!segment) throw new HttpError(404, 'Segment not found');
      res.json(segment);
    }),
  );

  app.post(
    '/api/segments',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const seg = parseSegment(req.body);
      const id = await insertId(db, 'segments', seg);
      syncInBackground(id, seg.network, seg.subnet_mask);
      res.json({ id, ...seg });
    }),
  );

  app.put(
    '/api/segments/:id',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const id = Number(req.params.id);
      const seg = parseSegment(req.body);
      const updated = await db('segments').where({ id }).update(seg);
      if (!updated) throw new HttpError(404, 'Segment not found');
      syncInBackground(id, seg.network, seg.subnet_mask);
      res.json({ success: true });
    }),
  );

  app.delete(
    '/api/segments/:id',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      await db('segments').where({ id: Number(req.params.id) }).del();
      res.json({ success: true });
    }),
  );

  // Refresh: ping a segment's addresses now. Small segments answer when done;
  // big ones (over 1,024 addresses) are checked in the background (202).
  // Clicking again while one runs joins it instead of starting another.
  const refreshJobs = new Map<number, Promise<number>>();
  app.post(
    '/api/segments/:id/refresh',
    requireAuth,
    ah(async (req, res) => {
      const id = Number(req.params.id);
      const segment = await db('segments').where({ id }).first('id');
      if (!segment) throw new HttpError(404, 'Segment not found');
      const addresses = Number((await db('ips').where({ segment_id: id }).count({ n: '*' }))[0].n);
      let job = refreshJobs.get(id);
      if (!job) {
        job = refreshSegment(id).finally(() => refreshJobs.delete(id));
        refreshJobs.set(id, job);
      }
      if (addresses > 1024) {
        job.catch((e) => console.error(`Refresh of segment ${id} failed: ${explainDbError(e)}`));
        return res.status(202).json({ background: true, addresses });
      }
      res.json({ checked: await job, at: nowIso() });
    }),
  );

  /* ---------------- IPs ---------------- */

  app.get(
    '/api/segments/:segmentId/ips',
    requireAuth,
    ah(async (req, res) => {
      res.json(await db('ips').where({ segment_id: Number(req.params.segmentId) }).orderBy('ip_long'));
    }),
  );

  app.post(
    '/api/segments/:segmentId/ips',
    requireAuth,
    requireRole(['admin', 'editor']),
    ah(async (req, res) => {
      const { hostname, os, description } = req.body || {};
      const ip_address = String(req.body?.ip_address || '').trim();
      if (!IPV4.test(ip_address)) throw new HttpError(400, 'Enter a valid IPv4 address.');
      try {
        const id = await insertId(db, 'ips', {
          segment_id: Number(req.params.segmentId),
          ip_address,
          ip_long: ipToLong(ip_address),
          hostname: hostname || null,
          os: os || null,
          description: description || null,
          status: 'unknown',
          created_by: req.user.id,
          created_at: nowIso(),
          notification_count: 0,
          mute_notifications: 0,
        });
        res.json(await db('ips').where({ id }).first());
      } catch (e) {
        if (isUniqueViolation(e)) throw new HttpError(400, 'IP address already exists in this segment');
        throw e;
      }
    }),
  );

  app.put(
    '/api/ips/:id',
    requireAuth,
    requireRole(['admin', 'editor']),
    ah(async (req, res) => {
      const { hostname, os, description } = req.body || {};
      await db('ips')
        .where({ id: Number(req.params.id) })
        .update({ hostname: hostname || null, os: os || null, description: description || null });
      res.json({ success: true });
    }),
  );

  app.delete(
    '/api/ips/:id',
    requireAuth,
    requireRole(['admin', 'editor']),
    ah(async (req, res) => {
      await db('ips').where({ id: Number(req.params.id) }).del();
      res.json({ success: true });
    }),
  );

  app.post(
    '/api/ips/:id/mute',
    requireAuth,
    ah(async (req, res) => {
      await db('ips').where({ id: Number(req.params.id) }).update({ mute_notifications: 1 });
      res.json({ success: true });
    }),
  );

  /* ---------------- notifications ---------------- */

  app.get(
    '/api/notifications',
    requireAuth,
    ah(async (_req, res) => {
      res.json(await db('notifications').select('*').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(50));
    }),
  );

  app.post(
    '/api/notifications/:id/read',
    requireAuth,
    ah(async (req, res) => {
      await db('notifications').where({ id: Number(req.params.id) }).update({ is_read: 1 });
      res.json({ success: true });
    }),
  );

  /* ---------------- users ---------------- */

  app.get(
    '/api/users',
    requireAuth,
    requireRole(['admin']),
    ah(async (_req, res) => {
      res.json(await db('users').select('id', 'username', 'role', 'is_local').orderBy('id'));
    }),
  );

  app.post(
    '/api/users',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      const role = requireRoleValue(req.body?.role);
      if (!username || !password) throw new HttpError(400, 'Enter a user name and password.');
      try {
        const id = await insertId(db, 'users', { username, password_hash: bcrypt.hashSync(password, 10), role, is_local: 1 });
        res.json({ id, username, role, is_local: 1 });
      } catch (e) {
        if (isUniqueViolation(e)) throw new HttpError(400, 'That user name is already taken.');
        throw e;
      }
    }),
  );

  app.put(
    '/api/users/:id',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const username = String(req.body?.username || '').trim();
      const role = requireRoleValue(req.body?.role);
      if (!username) throw new HttpError(400, 'Enter a user name.');
      const changes: Record<string, unknown> = { username, role };
      if (req.body?.password) changes.password_hash = bcrypt.hashSync(String(req.body.password), 10);
      try {
        await db('users').where({ id: Number(req.params.id) }).update(changes);
      } catch (e) {
        if (isUniqueViolation(e)) throw new HttpError(400, 'That user name is already taken.');
        throw e;
      }
      res.json({ success: true });
    }),
  );

  app.delete(
    '/api/users/:id',
    requireAuth,
    requireRole(['admin']),
    ah(async (req: any, res) => {
      const id = Number(req.params.id);
      if (id === Number(req.user.id)) throw new HttpError(400, 'You cannot delete the account you are signed in with.');
      await db('users').where({ id }).whereNot({ username: 'admin' }).del();
      res.json({ success: true });
    }),
  );

  /* ---------------- LDAP servers ---------------- */

  // Stored service-account passwords never leave the server.
  app.get(
    '/api/ldap',
    requireAuth,
    requireRole(['admin']),
    ah(async (_req, res) => {
      const rows = await db('ldap_servers').select('*').orderBy('id');
      res.json(rows.map(({ password, ...rest }: any) => ({ ...rest, passwordSet: !!password })));
    }),
  );

  const parseLdap = (body: any) => {
    const server_name = String(body?.server_name || '').trim();
    const dc_addresses = String(body?.dc_addresses || '').trim();
    const service_account = String(body?.service_account || '').trim();
    const port = Number(body?.port) || 389;
    if (!server_name || !dc_addresses || !service_account) throw new HttpError(400, 'Fill in the server name, DC addresses and service account.');
    if (port < 1 || port > 65535) throw new HttpError(400, 'The port must be between 1 and 65535.');
    return { server_name, dc_addresses, port, service_account };
  };

  app.post(
    '/api/ldap',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const server = parseLdap(req.body);
      const password = String(req.body?.password || '');
      if (!password) throw new HttpError(400, 'Enter the service account password.');
      const id = await insertId(db, 'ldap_servers', { ...server, password });
      res.json({ id, ...server, passwordSet: true });
    }),
  );

  app.put(
    '/api/ldap/:id',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const server: Record<string, unknown> = parseLdap(req.body);
      // A blank password means "keep the stored one" (as the form says).
      if (req.body?.password) server.password = String(req.body.password);
      await db('ldap_servers').where({ id: Number(req.params.id) }).update(server);
      res.json({ success: true });
    }),
  );

  app.delete(
    '/api/ldap/:id',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      await db('ldap_servers').where({ id: Number(req.params.id) }).del();
      res.json({ success: true });
    }),
  );

  app.post(
    '/api/ldap/test',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const { dc_addresses, port, service_account } = req.body || {};
      let password = String(req.body?.password || '');
      // Testing an existing server without retyping its password: reuse the stored
      // one, but only while the address, port and account are unchanged.
      if (!password && req.body?.id) {
        const stored = await db('ldap_servers').where({ id: Number(req.body.id) }).first();
        if (stored && stored.dc_addresses === dc_addresses && Number(stored.port) === Number(port) && stored.service_account === service_account) {
          password = stored.password;
        }
      }
      if (!dc_addresses || !port || !service_account || !password) {
        throw new HttpError(400, 'Fill in the DC addresses, port, service account and password to test.');
      }

      let lastError: any = null;
      for (const address of String(dc_addresses).split(',').map((a) => a.trim()).filter(Boolean)) {
        const client = new Client({ url: `ldap://${address}:${port}`, timeout: 5000, connectTimeout: 5000 });
        try {
          await client.bind(service_account, password);
          await client.unbind();
          return res.json({ success: true, message: `Connection successful (${address})` });
        } catch (err) {
          lastError = err;
          try {
            await client.unbind();
          } catch {
            /* ignore */
          }
        }
      }
      const msg = String(lastError?.message || '');
      let error = msg || 'Connection failed';
      if (/InvalidCredentials|\b49\b/.test(msg)) error = 'Invalid credentials (service account or password incorrect)';
      else if (/ECONNREFUSED|timeout|ETIMEDOUT|ENOTFOUND/i.test(msg)) error = 'Could not connect to the LDAP server (check address and port)';
      res.status(400).json({ error });
    }),
  );

  /* ---------------- AD groups ---------------- */

  app.get(
    '/api/ad-groups',
    requireAuth,
    requireRole(['admin']),
    ah(async (_req, res) => {
      res.json(await db('ad_groups').select('*').orderBy('group_name'));
    }),
  );

  app.post(
    '/api/ad-groups',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const group_name = String(req.body?.group_name || '').trim();
      const role = requireRoleValue(req.body?.role);
      if (!group_name) throw new HttpError(400, 'Enter the AD group name.');
      try {
        const id = await insertId(db, 'ad_groups', { group_name, role });
        res.json({ id, group_name, role });
      } catch (e) {
        if (isUniqueViolation(e)) throw new HttpError(400, 'That AD group is already listed.');
        throw e;
      }
    }),
  );

  app.put(
    '/api/ad-groups/:id',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const group_name = String(req.body?.group_name || '').trim();
      const role = requireRoleValue(req.body?.role);
      if (!group_name) throw new HttpError(400, 'Enter the AD group name.');
      try {
        await db('ad_groups').where({ id: Number(req.params.id) }).update({ group_name, role });
      } catch (e) {
        if (isUniqueViolation(e)) throw new HttpError(400, 'That AD group is already listed.');
        throw e;
      }
      res.json({ success: true });
    }),
  );

  app.delete(
    '/api/ad-groups/:id',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      await db('ad_groups').where({ id: Number(req.params.id) }).del();
      res.json({ success: true });
    }),
  );

  /* ---------------- database settings ---------------- */

  app.get(
    '/api/settings/database',
    requireAuth,
    requireRole(['admin']),
    ah(async (_req, res) => {
      res.json(await getStatus());
    }),
  );

  app.post(
    '/api/settings/database/test',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      try {
        const config = withStoredPassword(normalizeConfig(req.body?.config ?? req.body));
        res.json({ success: true, ...(await testConnection(config)) });
      } catch (e) {
        res.status(400).json({ error: explainDbError(e) });
      }
    }),
  );

  app.put(
    '/api/settings/database',
    requireAuth,
    requireRole(['admin']),
    ah(async (req, res) => {
      const result = await switchDatabase(req.body?.config ?? req.body, !!req.body?.copyData);
      res.json({ success: true, ...result });
    }),
  );

  /* ---------------- software & upgrade ---------------- */

  app.get(
    '/api/system',
    requireAuth,
    requireRole(['admin']),
    ah(async (_req, res) => {
      res.json(await systemInfo());
    }),
  );

  // Body = the IPAM-Setup-x.y.z.exe itself (application/octet-stream).
  app.post(
    '/api/system/upgrade',
    requireAuth,
    requireRole(['admin']),
    ah(async (req: any, res) => {
      res.json({ pending: await receiveUpload(req, req.user.username) });
    }),
  );

  app.post(
    '/api/system/upgrade/install',
    requireAuth,
    requireRole(['admin']),
    ah(async (req: any, res) => {
      res.status(202).json(await installPending(req.user.username));
    }),
  );

  app.delete(
    '/api/system/upgrade',
    requireAuth,
    requireRole(['admin']),
    ah(async (_req, res) => {
      discardPending();
      res.json({ success: true });
    }),
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  /* ---------------- UI ---------------- */

  if (!isProd) {
    // Imported by name at runtime so the bundled executable never pulls in Vite.
    const viteModule = 'vite';
    const { createServer } = await import(viteModule);
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(appRoot, 'dist');
    app.use(express.static(distDir, { index: 'index.html', maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError || err instanceof UpgradeError) return res.status(err.status).json({ error: err.message });
    if (err instanceof DbError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (isConnectionError(err)) return res.status(503).json({ error: `The database is not reachable: ${explainDbError(err)}` });
    console.error('Request failed:', err?.message || err);
    res.status(500).json({ error: explainDbError(err) });
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`IPAM ${appVersion} running on http://localhost:${PORT} (data: ${dataDir})`);
    // Started by double-clicking ipam.exe (not as the Windows service): open the browser.
    if (isPackaged && !process.env.IPAM_SERVICE && process.platform === 'win32') {
      exec(`start "" "http://localhost:${PORT}/"`);
    }
  });
  server.on('error', (e: any) => {
    if (e?.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set PORT to a free port.`);
    else console.error('Server error:', e?.message || e);
    process.exit(1);
  });
}

/** `ipam.exe --reset-admin`: the local "admin" account gets password admin123 again. */
async function resetAdmin() {
  await initDatabase({ retry: false });
  const hash = bcrypt.hashSync('admin123', 10);
  const existing = await db('users').where({ username: 'admin' }).first('id');
  if (existing) await db('users').where({ id: existing.id }).update({ password_hash: hash, role: 'admin', is_local: 1 });
  else await insertId(db, 'users', { username: 'admin', password_hash: hash, role: 'admin', is_local: 1 });
  console.log(`The local account "admin" now has the password admin123 (data: ${dataDir}). Sign in and change it.`);
  await db.destroy();
}

process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled rejection:', reason?.message || reason);
});

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(`IPAM ${appVersion}`);
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      `IPAM ${appVersion} - IP Address Management`,
      '',
      '  (no arguments)   start the server (PORT, default 3000)',
      '  --reset-admin    set the local "admin" password back to admin123',
      '  --version        print the version',
      '',
      `Data folder: ${dataDir}`,
    ].join('\n'),
  );
} else if (args.includes('--reset-admin')) {
  resetAdmin().then(
    () => process.exit(0),
    (e) => {
      console.error(`Could not reset the admin password: ${explainDbError(e)}`);
      process.exit(1);
    },
  );
} else {
  startServer().catch((e) => {
    console.error('IPAM failed to start:', explainDbError(e));
    process.exit(1);
  });
}
