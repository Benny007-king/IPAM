import fs from 'node:fs';
import path from 'node:path';
import knexFactory, { Knex } from 'knex';
import bcrypt from 'bcryptjs';
import { dataDir, exeDir, isPackaged, writeFileAtomic } from './paths.js';

/* ------------------------------------------------------------------------- */
/* Configuration                                                             */
/* ------------------------------------------------------------------------- */

export type DbClient = 'sqlite' | 'postgres' | 'mysql' | 'mssql';

/** off = plain connection; verify = TLS with a trusted certificate; trust = TLS, any certificate. */
export type TlsMode = 'off' | 'verify' | 'trust';

export interface DbConfig {
  client: DbClient;
  filename?: string; // sqlite
  host?: string; // others; SQL Server also accepts "host\INSTANCE"
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  tls?: TlsMode;
}

export type ConfigSource = 'env' | 'file' | 'default';

export const CLIENT_LABELS: Record<DbClient, string> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mssql: 'Microsoft SQL Server',
};

export const DEFAULT_PORTS: Record<Exclude<DbClient, 'sqlite'>, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
};

const CONFIG_FILE = path.join(dataDir, 'database.json');

export class DbError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function defaultSqlitePath(): string {
  return path.resolve(process.env.DB_PATH || path.join(dataDir, 'ipam.db'));
}

function aliasClient(value: string): DbClient {
  const v = value.trim().toLowerCase();
  if (['sqlite', 'sqlite3', 'better-sqlite3', 'file'].includes(v)) return 'sqlite';
  if (['postgres', 'postgresql', 'pg'].includes(v)) return 'postgres';
  if (['mysql', 'mysql2', 'mariadb'].includes(v)) return 'mysql';
  if (['mssql', 'sqlserver', 'sql-server', 'tedious'].includes(v)) return 'mssql';
  throw new DbError(`Unknown database type "${value}". Use sqlite, postgres, mysql or mssql.`);
}

function tlsFrom(value: string | null | undefined): TlsMode | undefined {
  if (value == null || value === '') return undefined;
  const v = value.trim().toLowerCase();
  if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(v)) return 'off';
  if (['verify', 'verify-full', 'verify-ca', 'true', '1', 'yes', 'on'].includes(v)) return 'verify';
  if (['trust', 'require', 'required', 'prefer', 'no-verify', 'allow'].includes(v)) return 'trust';
  throw new DbError(`Unknown TLS mode "${value}". Use off, verify or trust.`);
}

/** Parse a connection URL such as postgres://user:pass@host:5432/ipam?sslmode=require. */
export function parseDbUrl(raw: string): DbConfig {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new DbError('That is not a valid connection URL.');
  }
  const client = aliasClient(u.protocol.replace(/:$/, ''));
  if (client === 'sqlite') {
    let file = decodeURIComponent(u.pathname || u.host);
    if (/^\/[A-Za-z]:/.test(file)) file = file.slice(1); // sqlite:///C:/data/ipam.db
    return { client, filename: file };
  }
  const p = u.searchParams;
  let host = decodeURIComponent(u.hostname);
  const instance = p.get('instanceName') || p.get('instance');
  if (instance) host = `${host}\\${instance}`;
  let tls = tlsFrom(p.get('sslmode') ?? p.get('ssl') ?? p.get('tls') ?? p.get('encrypt'));
  if (p.get('trustServerCertificate') === 'true' && tls !== 'off') tls = 'trust';
  return {
    client,
    host,
    port: u.port ? Number(u.port) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    tls,
  };
}

/** Validate a config and fill in defaults. Throws DbError with a readable message. */
export function normalizeConfig(input: any): DbConfig {
  if (!input || typeof input !== 'object') throw new DbError('Missing database settings.');
  if (typeof input.url === 'string' && input.url.trim()) {
    const parsed = parseDbUrl(input.url);
    // A password typed separately wins over one embedded in the URL.
    if (input.password) parsed.password = input.password;
    input = parsed;
  }
  const client = aliasClient(String(input.client || ''));
  if (client === 'sqlite') {
    const filename = String(input.filename || '').trim() || defaultSqlitePath();
    return { client, filename: path.resolve(filename) };
  }
  const host = String(input.host || '').trim();
  const database = String(input.database || '').trim();
  const user = String(input.user || '').trim();
  if (!host) throw new DbError('Enter the database server address.');
  if (!database) throw new DbError('Enter the database name.');
  if (!user) throw new DbError('Enter the user name.');
  let port = input.port === '' || input.port == null ? DEFAULT_PORTS[client] : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DbError('The port must be a number between 1 and 65535.');
  const tls = tlsFrom(input.tls) ?? (client === 'mssql' ? 'trust' : 'off');
  return { client, host, port, database, user, password: input.password ? String(input.password) : '', tls };
}

function configFromEnv(): DbConfig | null {
  const env = process.env;
  if (env.DATABASE_URL) return normalizeConfig({ url: env.DATABASE_URL });
  if (!env.DB_CLIENT) return null;
  return normalizeConfig({
    client: env.DB_CLIENT,
    filename: env.DB_PATH,
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    tls: env.DB_TLS ?? env.DB_SSL,
  });
}

function loadConfig(): { config: DbConfig; source: ConfigSource } {
  const fromEnv = configFromEnv();
  if (fromEnv) return { config: fromEnv, source: 'env' };
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return { config: normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))), source: 'file' };
    } catch (e: any) {
      // Never silently fall back to an empty SQLite file: that would look like data loss.
      throw new DbError(`Cannot read ${CONFIG_FILE}: ${e.message}. Fix or delete that file to use the built-in SQLite database.`);
    }
  }
  return { config: { client: 'sqlite', filename: defaultSqlitePath() }, source: 'default' };
}

function sameTarget(a: DbConfig, b: DbConfig): boolean {
  if (a.client !== b.client) return false;
  if (a.client === 'sqlite') return path.resolve(a.filename!).toLowerCase() === path.resolve(b.filename!).toLowerCase();
  return a.host?.toLowerCase() === b.host?.toLowerCase() && a.port === b.port && a.database === b.database;
}

/** Public view of a config: never includes the password. */
export function describeConfig(c: DbConfig) {
  return {
    client: c.client,
    label: CLIENT_LABELS[c.client],
    filename: c.filename,
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    tls: c.tls,
    passwordSet: !!c.password,
  };
}

/* ------------------------------------------------------------------------- */
/* Connections                                                               */
/* ------------------------------------------------------------------------- */

function sqliteNativeBinding(): string | undefined {
  // ipam.exe ships better_sqlite3.node next to itself, built for its embedded Node.
  if (!isPackaged) return undefined;
  const candidate = path.join(exeDir, 'better_sqlite3.node');
  if (fs.existsSync(candidate)) return candidate;
  throw new DbError(`better_sqlite3.node is missing next to ${process.execPath}. Reinstall IPAM.`, 500);
}

function splitInstance(host: string): { server: string; instanceName?: string } {
  const i = host.indexOf('\\');
  return i === -1 ? { server: host } : { server: host.slice(0, i), instanceName: host.slice(i + 1) };
}

function knexConfig(c: DbConfig): Knex.Config {
  const remotePool = { min: 0, max: 10 };
  const acquireConnectionTimeout = 15000;
  switch (c.client) {
    case 'sqlite': {
      fs.mkdirSync(path.dirname(c.filename!), { recursive: true });
      const nativeBinding = sqliteNativeBinding();
      return {
        client: 'better-sqlite3',
        connection: { filename: c.filename!, options: nativeBinding ? { nativeBinding } : {} },
        useNullAsDefault: true,
        pool: {
          min: 1,
          max: 1,
          afterCreate(conn: any, done: (err: Error | null, conn: any) => void) {
            try {
              conn.pragma('journal_mode = WAL');
              conn.pragma('foreign_keys = ON');
              conn.pragma('busy_timeout = 5000');
              done(null, conn);
            } catch (e: any) {
              done(e, conn);
            }
          },
        },
      };
    }
    case 'postgres':
      return {
        client: 'pg',
        connection: {
          host: c.host,
          port: c.port,
          database: c.database,
          user: c.user,
          password: c.password,
          ssl: c.tls === 'off' ? false : { rejectUnauthorized: c.tls === 'verify' },
          connectionTimeoutMillis: 10000,
          application_name: 'IPAM',
        } as any,
        pool: remotePool,
        acquireConnectionTimeout,
      };
    case 'mysql':
      return {
        client: 'mysql2',
        connection: {
          host: c.host,
          port: c.port,
          database: c.database,
          user: c.user,
          password: c.password,
          // mysql2 only uses TLS when an ssl object is given, so "off" really is off.
          ssl: c.tls === 'off' ? undefined : { rejectUnauthorized: c.tls === 'verify' },
          connectTimeout: 10000,
          charset: 'utf8mb4',
          dateStrings: true,
        } as any,
        pool: remotePool,
        acquireConnectionTimeout,
      };
    case 'mssql': {
      const { server, instanceName } = splitInstance(c.host!);
      const encrypt = c.tls !== 'off';
      return {
        client: 'mssql',
        connection: {
          server,
          port: c.port,
          database: c.database,
          user: c.user,
          password: c.password,
          encrypt,
          connectionTimeout: 10000,
          options: { encrypt, trustServerCertificate: c.tls === 'trust', instanceName, appName: 'IPAM' },
        } as any,
        pool: remotePool,
        acquireConnectionTimeout,
      };
    }
  }
}

// One readable line per driver warning instead of a stack trace.
const knexLog = {
  warn: (m: any) => console.warn(`[db] ${String(m?.message ?? m).split('\n')[0]}`),
  error: (m: any) => console.error(`[db] ${String(m?.message ?? m).split('\n')[0]}`),
  deprecate: () => {},
  debug: () => {},
};

function openKnex(c: DbConfig): Knex {
  return knexFactory({ ...knexConfig(c), log: knexLog });
}

/** True when an error means "cannot reach the database" rather than a bad query. */
export function isConnectionError(e: any): boolean {
  const code = e?.code;
  return (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ESOCKET', 'ETIMEOUT', 'PROTOCOL_CONNECTION_LOST'].includes(code) ||
    /Timeout acquiring a connection|Connection terminated|connection is closed|Connection lost|socket hang up/i.test(String(e?.message || ''))
  );
}

/** Is the active database answering right now? */
export async function pingDatabase(): Promise<boolean> {
  if (!current) return false;
  try {
    await current.raw('select 1');
    return true;
  } catch {
    return false;
  }
}

async function rawFirst(k: Knex, client: DbClient, sql: string): Promise<any> {
  const r: any = await k.raw(sql);
  const rows = client === 'postgres' ? r.rows : client === 'mysql' ? r[0] : r;
  return Array.isArray(rows) ? rows[0] : undefined;
}

async function serverVersion(k: Knex, client: DbClient): Promise<string> {
  switch (client) {
    case 'sqlite':
      return `SQLite ${(await rawFirst(k, client, 'select sqlite_version() as v'))?.v ?? ''}`.trim();
    case 'postgres': {
      const v = String((await rawFirst(k, client, 'select version() as v'))?.v ?? '');
      return v.split(' ').slice(0, 2).join(' ') || 'PostgreSQL';
    }
    case 'mysql': {
      const v = String((await rawFirst(k, client, 'select version() as v'))?.v ?? '');
      return /mariadb/i.test(v) ? `MariaDB ${v.split('-')[0]}` : `MySQL ${v}`;
    }
    case 'mssql': {
      const row = await rawFirst(
        k,
        client,
        "select cast(serverproperty('ProductVersion') as nvarchar(64)) as v, cast(serverproperty('Edition') as nvarchar(128)) as e",
      );
      return `SQL Server ${row?.v ?? ''}${row?.e ? ` (${row.e})` : ''}`.trim();
    }
  }
}

/** Turn driver errors into one readable sentence. */
export function explainDbError(e: any): string {
  if (e instanceof DbError) return e.message;
  const code = e?.code || e?.errno;
  const msg = String(e?.message || e || 'Unknown error').replace(/\s+/g, ' ').trim();
  if (/does not support SSL|server does not support secure|SSL connection is required|requires secure/i.test(msg)) {
    return /required|requires/i.test(msg)
      ? 'The server only accepts encrypted connections. Turn TLS on.'
      : 'The server does not accept TLS connections. Set TLS to off.';
  }
  // Checked before socket errors: SQL Server reports certificate failures as ESOCKET too.
  if (/self[- ]signed|certificate|unable to verify|CERT_|DEPTH_ZERO/i.test(msg)) {
    const detail = String(e?.cause?.message || msg)
      .replace(/;\s*if the root CA.*$/i, '')
      .replace(/^Failed to connect to \S+ - /i, '');
    return `The server's certificate was not accepted (${detail}). Trust its CA on this computer, or choose "On - accept any certificate".`;
  }
  // SQL Server answers every refused sign-in with the same "Login failed".
  if (code === 'ELOGIN')
    return 'SQL Server refused the sign-in: wrong user name or password, the database does not exist, or that login has no access to it.';
  if (code === 'ECONNREFUSED') return 'Connection refused: nothing is listening at that address and port.';
  // tedious (SQL Server) reports refused/unreachable sockets as ESOCKET.
  if (code === 'ESOCKET' || /Failed to connect to|Could not connect \(sequence\)/i.test(msg))
    return 'Could not reach the server at that address and port (nothing answered, or a firewall blocked it). For a named instance, enter server\\INSTANCE.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The server name could not be resolved.';
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) return 'The server did not answer in time (check the address, port and firewall).';
  if (code === '28P01' || code === 'ER_ACCESS_DENIED_ERROR' || /login failed|password authentication failed|access denied/i.test(msg))
    return 'The server refused the user name or password.';
  if (code === '3D000' || code === 'ER_BAD_DB_ERROR' || /cannot open database|does not exist|unknown database/i.test(msg))
    return 'That database does not exist on the server. Create it first (an empty database is enough).';
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

/* ------------------------------------------------------------------------- */
/* Schema                                                                    */
/* ------------------------------------------------------------------------- */

const SCHEMA_VERSION = 2;
const DATA_TABLES = ['users', 'segments', 'ips', 'notifications', 'ldap_servers', 'ad_groups'] as const;

export function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

async function addColumnIfMissing(k: Knex, table: string, column: string, add: (t: Knex.AlterTableBuilder) => void) {
  if (!(await k.schema.hasColumn(table, column))) await k.schema.alterTable(table, add);
}

/**
 * Create the IPAM tables when they are missing, and bring older SQLite files
 * up to date. Portable across all four engines: flags are integers 0/1 and
 * timestamps are ISO-8601 text, so no engine converts them by time zone.
 */
export async function ensureSchema(k: Knex): Promise<void> {
  // k.schema returns a NEW builder on every access; a stored builder would
  // accumulate statements and replay earlier CREATE TABLEs.
  const s = { hasTable: (t: string) => k.schema.hasTable(t), createTable: (t: string, cb: (b: Knex.CreateTableBuilder) => void) => k.schema.createTable(t, cb) };

  if (!(await s.hasTable('users'))) {
    await s.createTable('users', (t) => {
      t.increments('id').primary();
      t.string('username', 255).notNullable().unique();
      t.string('password_hash', 255).nullable();
      t.string('role', 16).notNullable();
      t.integer('is_local').notNullable().defaultTo(0);
    });
  }

  if (!(await s.hasTable('segments'))) {
    await s.createTable('segments', (t) => {
      t.increments('id').primary();
      t.string('name', 255).notNullable();
      t.string('network', 45).notNullable();
      t.string('subnet_mask', 45).notNullable();
      t.text('description').nullable();
    });
  }

  if (!(await s.hasTable('ips'))) {
    await s.createTable('ips', (t) => {
      t.increments('id').primary();
      t.integer('segment_id').unsigned().notNullable().references('id').inTable('segments').onDelete('CASCADE');
      t.string('ip_address', 45).notNullable();
      t.bigInteger('ip_long').nullable();
      t.string('hostname', 255).nullable();
      t.string('os', 255).nullable();
      t.text('description').nullable();
      t.string('status', 16).defaultTo('unknown');
      t.string('last_seen', 40).nullable();
      t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
      t.string('created_at', 40).nullable();
      t.string('offline_since', 40).nullable();
      t.integer('notification_count').defaultTo(0);
      t.integer('mute_notifications').defaultTo(0);
      t.unique(['segment_id', 'ip_address']);
    });
  }

  if (!(await s.hasTable('notifications'))) {
    await s.createTable('notifications', (t) => {
      t.increments('id').primary();
      t.integer('ip_id').unsigned().notNullable().references('id').inTable('ips').onDelete('CASCADE');
      t.text('message').notNullable();
      t.string('type', 32).notNullable();
      t.integer('is_read').defaultTo(0);
      t.string('created_at', 40).nullable();
      t.index(['created_at']);
    });
  }

  if (!(await s.hasTable('ldap_servers'))) {
    await s.createTable('ldap_servers', (t) => {
      t.increments('id').primary();
      t.string('server_name', 255).notNullable();
      t.text('dc_addresses').notNullable();
      t.integer('port').notNullable().defaultTo(389);
      t.string('service_account', 255).notNullable();
      t.text('password').notNullable();
    });
  }

  if (!(await s.hasTable('ad_groups'))) {
    await s.createTable('ad_groups', (t) => {
      t.increments('id').primary();
      t.string('group_name', 255).notNullable().unique();
      t.string('role', 16).notNullable();
    });
  }

  if (!(await s.hasTable('ipam_meta'))) {
    await s.createTable('ipam_meta', (t) => {
      t.string('meta_key', 64).primary();
      t.text('meta_value').nullable();
    });
  }

  // Columns added by earlier releases (only ever missing in old SQLite files).
  await addColumnIfMissing(k, 'ips', 'ip_long', (t) => void t.bigInteger('ip_long').nullable());
  await addColumnIfMissing(k, 'ips', 'os', (t) => void t.string('os', 255).nullable());
  await addColumnIfMissing(k, 'ips', 'offline_since', (t) => void t.string('offline_since', 40).nullable());
  await addColumnIfMissing(k, 'ips', 'notification_count', (t) => void t.integer('notification_count').defaultTo(0));
  await addColumnIfMissing(k, 'ips', 'mute_notifications', (t) => void t.integer('mute_notifications').defaultTo(0));
  await addColumnIfMissing(k, 'segments', 'subnet_mask', (t) => void t.string('subnet_mask', 45).notNullable().defaultTo(''));

  const missingLong = await k('ips').select('id', 'ip_address').whereNull('ip_long');
  for (const row of missingLong) {
    await k('ips').where({ id: row.id }).update({ ip_long: ipToLong(row.ip_address) });
  }

  // Very old installs kept a single LDAP server in ldap_settings.
  if ((await s.hasTable('ldap_settings')) && Number((await k('ldap_servers').count({ n: '*' }))[0].n) === 0) {
    const old = await k('ldap_settings').where({ id: 1 }).first();
    if (old) {
      await k('ldap_servers').insert({
        server_name: 'Primary LDAP',
        dc_addresses: old.dc_addresses,
        port: old.port,
        service_account: old.service_account,
        password: old.password,
      });
    }
  }

  const meta = await k('ipam_meta').where({ meta_key: 'schema_version' }).first();
  if (!meta) await k('ipam_meta').insert({ meta_key: 'schema_version', meta_value: String(SCHEMA_VERSION) });
  else if (Number(meta.meta_value) < SCHEMA_VERSION)
    await k('ipam_meta').where({ meta_key: 'schema_version' }).update({ meta_value: String(SCHEMA_VERSION) });
}

/** The built-in local admin (admin / admin123) — only when there is no "admin" user yet. */
async function seedAdminIfMissing(k: Knex): Promise<boolean> {
  const exists = await k('users').where({ username: 'admin' }).first('id');
  if (exists) return false;
  await k('users').insert({ username: 'admin', password_hash: bcrypt.hashSync('admin123', 10), role: 'admin', is_local: 1 });
  return true;
}

async function countData(k: Knex) {
  const counts: Record<string, number> = {};
  for (const t of DATA_TABLES) {
    counts[t] = (await k.schema.hasTable(t)) ? Number((await k(t).count({ n: '*' }))[0].n) : 0;
  }
  return counts;
}

/* ------------------------------------------------------------------------- */
/* The active connection                                                     */
/* ------------------------------------------------------------------------- */

let current: Knex | null = null;
let currentClient: DbClient = 'sqlite';
let currentConfig: DbConfig | null = null;
let currentSource: ConfigSource = 'default';
let currentVersion = '';
let lastError = '';
let paused = false;

function active(): Knex {
  if (!current) throw new DbError(`The database is not available${lastError ? `: ${lastError}` : ''}. Retrying…`, 503);
  return current;
}

/**
 * `db` always points at the active connection, so the rest of the app keeps
 * working when an administrator switches database at runtime.
 */
export const db: Knex = new Proxy(function () {} as unknown as Knex, {
  apply(_target, _this, args) {
    return (active() as any)(...args);
  },
  get(_target, prop) {
    const k: any = active();
    const value = k[prop];
    return typeof value === 'function' ? value.bind(k) : value;
  },
});

export const dbClient = () => currentClient;
export const isDbReady = () => !!current && !paused;
export const dbError = () => lastError;

/** Insert one row and return its new id, on every engine. */
export async function insertId(q: Knex | Knex.Transaction, table: string, row: Record<string, unknown>): Promise<number> {
  // RETURNING is used where it is native; SQLite and MySQL hand back the new id themselves.
  const useReturning = currentClient === 'postgres' || currentClient === 'mssql';
  const res: any[] = useReturning ? await q(table).insert(row, ['id']) : await q(table).insert(row);
  const first = res[0];
  return Number(typeof first === 'object' && first !== null ? first.id : first);
}

export function isUniqueViolation(e: any): boolean {
  const code = e?.code;
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === '23505' ||
    code === 'ER_DUP_ENTRY' ||
    e?.number === 2627 ||
    e?.number === 2601 ||
    /UNIQUE constraint failed|duplicate key|Duplicate entry/i.test(String(e?.message || ''))
  );
}

export const nowIso = () => new Date().toISOString();

let retryTimer: NodeJS.Timeout | null = null;

/**
 * Connect at start-up. If an external database is unreachable the server still
 * starts (so the error can be seen) and keeps retrying every 15 seconds.
 */
export async function initDatabase(opts: { retry?: boolean } = {}): Promise<void> {
  const retry = opts.retry ?? true;
  const { config, source } = loadConfig();
  currentConfig = config;
  currentSource = source;
  currentClient = config.client;
  const k = openKnex(config);
  try {
    currentVersion = await serverVersion(k, config.client);
    await ensureSchema(k);
    if (await seedAdminIfMissing(k)) console.log('Created the default local admin (admin / admin123) - change its password.');
    current = k;
    lastError = '';
    console.log(`Database: ${currentVersion} (${describeTarget(config)})`);
  } catch (e) {
    await k.destroy().catch(() => {});
    lastError = explainDbError(e);
    if (!retry) throw new DbError(`Database unavailable (${describeTarget(config)}): ${lastError}`, 503);
    console.error(`Database unavailable (${describeTarget(config)}): ${lastError} - retrying in 15 s`);
    if (!retryTimer) {
      retryTimer = setInterval(async () => {
        if (current) return;
        await initDatabase().catch(() => {});
        if (current && retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }, 15000);
    }
  }
}

function describeTarget(c: DbConfig): string {
  return c.client === 'sqlite' ? c.filename! : `${c.user}@${c.host}${c.client === 'mssql' && c.host!.includes('\\') ? '' : `:${c.port}`}/${c.database}`;
}

export async function getStatus() {
  const counts = current ? await countData(current).catch(() => null) : null;
  return {
    source: currentSource,
    configFile: CONFIG_FILE,
    defaultSqlitePath: defaultSqlitePath(),
    connected: !!current,
    error: lastError || undefined,
    version: currentVersion,
    config: currentConfig ? describeConfig(currentConfig) : null,
    counts,
  };
}

/**
 * When the form leaves the password blank, reuse the stored one — but only for
 * the same server and user, so it can never be sent somewhere new.
 */
export function withStoredPassword(c: DbConfig): DbConfig {
  if (c.client === 'sqlite' || c.password || !currentConfig || currentConfig.client !== c.client) return c;
  const same =
    currentConfig.host?.toLowerCase() === c.host?.toLowerCase() && currentConfig.port === c.port && currentConfig.user === c.user;
  return same ? { ...c, password: currentConfig.password } : c;
}

export async function testConnection(c: DbConfig) {
  const k = openKnex(c);
  try {
    const version = await serverVersion(k, c.client);
    const hasTables = await k.schema.hasTable('segments');
    const counts = hasTables ? await countData(k) : null;
    const hasData = !!counts && Object.values(counts).some((n) => n > 0);
    return { version, hasIpamData: hasData, counts };
  } finally {
    await k.destroy().catch(() => {});
  }
}

/* ------------------------------------------------------------------------- */
/* Switching database (optionally copying everything across)                 */
/* ------------------------------------------------------------------------- */

function isoText(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return `${v.replace(' ', 'T')}Z`; // SQLite CURRENT_TIMESTAMP is UTC
  return v;
}

function portableValue(column: string, v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (column === 'ip_long' && typeof v === 'string') return Number(v);
  if (column === 'created_at' || column === 'last_seen' || column === 'offline_since') return isoText(v);
  return v;
}

async function copyAll(src: Knex, dst: Knex, dstClient: DbClient) {
  const copied: Record<string, number> = {};
  const kept: Record<string, Set<number>> = {};

  await dst.transaction(async (trx) => {
    for (const table of DATA_TABLES) {
      copied[table] = 0;
      kept[table] = new Set();
      if (!(await src.schema.hasTable(table))) continue;

      const targetColumns = new Set(Object.keys(await trx(table).columnInfo()));
      // SQL Server allows at most 2100 parameters in one statement.
      const columnCount = targetColumns.size;
      const batchSize = Math.max(1, Math.min(500, Math.floor(2000 / columnCount)));

      let lastId = 0;
      for (;;) {
        const rows = await src(table).where('id', '>', lastId).orderBy('id').limit(1000);
        if (rows.length === 0) break;
        lastId = Number(rows[rows.length - 1].id);

        const batch: Record<string, unknown>[] = [];
        for (const row of rows) {
          // Skip rows that point at something that no longer exists (old SQLite
          // files did not always enforce foreign keys).
          if (table === 'ips' && !kept.segments.has(Number(row.segment_id))) continue;
          if (table === 'notifications' && !kept.ips.has(Number(row.ip_id))) continue;
          const out: Record<string, unknown> = {};
          for (const [col, val] of Object.entries(row)) {
            if (targetColumns.has(col)) out[col] = portableValue(col, val);
          }
          if (table === 'ips' && out.created_by != null && !kept.users.has(Number(out.created_by))) out.created_by = null;
          batch.push(out);
          kept[table].add(Number(row.id));
        }
        for (let i = 0; i < batch.length; i += batchSize) {
          const slice = batch.slice(i, i + batchSize);
          if (dstClient === 'mssql') {
            // Ids are copied as they are. SQL Server only allows that with
            // IDENTITY_INSERT, and its drivers run each statement through
            // sp_executesql, where a SET lasts only for that one batch, so the
            // SET and the INSERT go in the same batch. (table: fixed list above)
            const q = trx(table).insert(slice).toSQL();
            await trx.raw(`SET IDENTITY_INSERT [${table}] ON; ${q.sql}; SET IDENTITY_INSERT [${table}] OFF;`, q.bindings as any);
          } else {
            await trx(table).insert(slice);
          }
        }
        copied[table] += batch.length;
      }

      if (dstClient === 'postgres') {
        // Explicit ids do not advance the sequence; move it past the copied rows.
        await trx.raw(`select setval(pg_get_serial_sequence(?, 'id'), coalesce((select max(id) from ??), 0) + 1, false)`, [table, table]);
      }
    }
  });
  return copied;
}

export async function switchDatabase(input: any, copyData: boolean) {
  if (currentSource === 'env') {
    throw new DbError('The database is set by environment variables (DB_CLIENT / DATABASE_URL). Change them and restart IPAM instead.', 409);
  }
  const target = withStoredPassword(normalizeConfig(input));
  if (currentConfig && sameTarget(target, currentConfig)) throw new DbError('IPAM is already using that database.');
  if (copyData && !current) throw new DbError('The current database is not reachable, so its data cannot be copied. Untick "copy my data".', 409);

  const k = openKnex(target);
  let copied: Record<string, number> | null = null;
  let seeded = false;
  paused = true; // hold the ping service while data moves
  try {
    const version = await serverVersion(k, target.client);
    await ensureSchema(k);
    const before = await countData(k);
    const hasData = Object.values(before).some((n) => n > 0);
    if (copyData) {
      if (hasData) {
        throw new DbError(
          'That database already holds IPAM data, so nothing was copied. Untick "copy my data" to use what is there, or choose an empty database.',
          409,
        );
      }
      copied = await copyAll(current!, k, target.client);
    }
    seeded = await seedAdminIfMissing(k);

    if (target.client === 'sqlite' && target.filename === defaultSqlitePath()) {
      fs.rmSync(CONFIG_FILE, { force: true }); // back to the default: no settings file needed
    } else {
      writeFileAtomic(CONFIG_FILE, JSON.stringify(target, null, 2));
    }

    const old = current;
    current = k;
    currentConfig = target;
    currentClient = target.client;
    currentSource = fs.existsSync(CONFIG_FILE) ? 'file' : 'default';
    currentVersion = version;
    lastError = '';
    // Let requests already running on the old connection finish first.
    if (old) setTimeout(() => old.destroy().catch(() => {}), 15000);
    console.log(`Switched database to ${version} (${describeTarget(target)})${copied ? ' - data copied' : ''}`);
    return { version, copied, seededAdmin: seeded, config: describeConfig(target) };
  } catch (e) {
    await k.destroy().catch(() => {});
    throw e instanceof DbError ? e : new DbError(explainDbError(e));
  } finally {
    paused = false;
  }
}
