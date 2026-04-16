import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const db = new Database('ipam.db');

// Enable foreign keys and WAL mode for better concurrency
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'readonly')),
    is_local BOOLEAN NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    network TEXT NOT NULL,
    subnet_mask TEXT NOT NULL,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_id INTEGER NOT NULL,
    ip_address TEXT NOT NULL,
    ip_long INTEGER,
    hostname TEXT,
    os TEXT,
    description TEXT,
    status TEXT DEFAULT 'unknown',
    last_seen DATETIME,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (segment_id) REFERENCES segments(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(segment_id, ip_address)
  );
`);

try {
  db.exec('ALTER TABLE ips ADD COLUMN ip_long INTEGER;');
} catch (e) {
  // Column might already exist
}

// Helper to update existing ips with ip_long
try {
  const ips = db.prepare('SELECT id, ip_address FROM ips WHERE ip_long IS NULL').all() as any[];
  if (ips.length > 0) {
    const updateStmt = db.prepare('UPDATE ips SET ip_long = ? WHERE id = ?');
    db.transaction(() => {
      for (const ip of ips) {
        const ipToLong = (ipStr: string) => ipStr.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
        updateStmt.run(ipToLong(ip.ip_address), ip.id);
      }
    })();
  }
} catch (e) {
  // Ignore
}

db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL,
    is_read BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ip_id) REFERENCES ips(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ldap_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,
    dc_addresses TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 389,
    service_account TEXT NOT NULL,
    password TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ad_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'readonly'))
  );
`);

// Migrate data from ldap_settings to ldap_servers if ldap_servers is empty
try {
  const existingServers = db.prepare('SELECT COUNT(*) as count FROM ldap_servers').get() as { count: number };
  if (existingServers.count === 0) {
    const oldSettings = db.prepare('SELECT * FROM ldap_settings WHERE id = 1').get() as any;
    if (oldSettings) {
      db.prepare('INSERT INTO ldap_servers (server_name, dc_addresses, port, service_account, password) VALUES (?, ?, ?, ?, ?)').run(
        'Primary LDAP', oldSettings.dc_addresses, oldSettings.port, oldSettings.service_account, oldSettings.password
      );
    }
  }
} catch (e) {
  // Ignore if ldap_settings doesn't exist
}

// Create default local admin if it doesn't exist
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash, role, is_local) VALUES (?, ?, ?, ?)').run('admin', hash, 'admin', 1);
}

// Migration: Add os to ips if it doesn't exist
try {
  const tableInfo = db.pragma('table_info(ips)') as any[];
  const hasOs = tableInfo.some(col => col.name === 'os');
  if (!hasOs) {
    db.exec('ALTER TABLE ips ADD COLUMN os TEXT');
  }
  if (!tableInfo.some(col => col.name === 'offline_since')) {
    db.exec('ALTER TABLE ips ADD COLUMN offline_since DATETIME');
  }
  if (!tableInfo.some(col => col.name === 'notification_count')) {
    db.exec('ALTER TABLE ips ADD COLUMN notification_count INTEGER DEFAULT 0');
  }
  if (!tableInfo.some(col => col.name === 'mute_notifications')) {
    db.exec('ALTER TABLE ips ADD COLUMN mute_notifications BOOLEAN DEFAULT 0');
  }
} catch (e) {
  console.error('Migration error for ips:', e);
}
try {
  const tableInfo = db.pragma('table_info(segments)') as any[];
  const hasSubnetMask = tableInfo.some(col => col.name === 'subnet_mask');
  if (!hasSubnetMask) {
    db.exec('ALTER TABLE segments ADD COLUMN subnet_mask TEXT NOT NULL DEFAULT ""');
  }
} catch (e) {
  console.error('Migration error:', e);
}

export default db;
