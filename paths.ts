import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

// "Verify the certificate" should accept what this computer trusts — e.g. an
// internal CA in the Windows certificate store — not only Node's bundled list.
// Applies to every TLS client created afterwards (database drivers, LDAP).
try {
  const t = tls as any;
  if (typeof t.getCACertificates === 'function' && typeof t.setDefaultCACertificates === 'function') {
    t.setDefaultCACertificates([...new Set([...t.getCACertificates('default'), ...t.getCACertificates('system')])]);
  }
} catch {
  /* older Node: bundled CAs only */
}

// Set by esbuild when the server is bundled for the Windows executable.
declare const __BUNDLED__: boolean | undefined;
declare const __APP_VERSION__: string | undefined;

/** True inside ipam.exe (built with pkg). */
export const isPackaged = !!(process as any).pkg;

const isBundled = typeof __BUNDLED__ !== 'undefined' && !!__BUNDLED__;

/** Folder that holds dist/ (the built UI) and package.json. */
export const appRoot = isBundled ? path.resolve(__dirname, '..') : process.cwd();

/** Folder ipam.exe lives in; the SQLite native addon is shipped next to it. */
export const exeDir = path.dirname(process.execPath);

/** DataDir= from the ipam.ini the installer writes next to ipam.exe. */
function installedDataDir(): string | null {
  try {
    const ini = fs.readFileSync(path.join(exeDir, 'ipam.ini'), 'utf8');
    const value = ini.match(/^\s*DataDir\s*=\s*(.+?)\s*$/im)?.[1];
    return value ? path.resolve(value) : null;
  } catch {
    return null;
  }
}

/**
 * Where IPAM keeps its data: the SQLite file, the database connection
 * settings and the session-signing secret.
 *   DATA_DIR            explicit
 *   DB_PATH             the folder of that SQLite file (Docker)
 *   installed ipam.exe  DataDir from ipam.ini (C:\ProgramData\IPAM), also when run by hand
 *   portable ipam.exe   a "data" folder next to the executable
 *   otherwise           the working directory (development)
 */
function resolveDataDir(): string {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  if (process.env.DB_PATH) return path.dirname(path.resolve(process.env.DB_PATH));
  if (isPackaged) return installedDataDir() ?? path.join(exeDir, 'data');
  return process.cwd();
}

export const dataDir = resolveDataDir();
fs.mkdirSync(dataDir, { recursive: true });

function readPackageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
  } catch {
    return 'dev';
  }
}

export const appVersion = typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : readPackageVersion();

/** Write a file atomically (temp file + rename) so a crash never leaves it half-written. */
export function writeFileAtomic(file: string, contents: string, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, file);
}
