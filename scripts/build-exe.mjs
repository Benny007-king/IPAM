// Builds the Windows executable:
//   release/ipam/ipam.exe            server + UI + Node runtime in one file
//   release/ipam/better_sqlite3.node the SQLite engine, loaded from beside the exe
//   release/ipam/nssm.exe            runs ipam.exe as a Windows service
//   release/IPAM-<version>-win-x64-portable.zip
// The installer (installer/ipam.iss) is compiled from release/ipam afterwards.
//
// Usage: node scripts/build-exe.mjs [--skip-ui]
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const nodeMajor = process.versions.node.split('.')[0];
const out = path.join(root, 'release', 'ipam');
const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
};

if (process.platform !== 'win32') {
  console.error('The Windows executable has to be built on Windows (the SQLite engine is native code).');
  process.exit(1);
}

rmSync(path.join(root, 'release'), { recursive: true, force: true });
rmSync(path.join(root, 'build'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. The web UI.
if (!process.argv.includes('--skip-ui')) run('npx vite build');
if (!existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('dist/index.html is missing - run vite build');

// 2. The server, bundled into one CommonJS file. Native code and drivers IPAM does
//    not ship stay external; Knex only loads the driver of the database in use.
await build({
  entryPoints: [path.join(root, 'server.ts')],
  outfile: path.join(root, 'build', 'server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${nodeMajor}`,
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    __BUNDLED__: 'true',
    __APP_VERSION__: JSON.stringify(version),
  },
  external: [
    'better-sqlite3', // native: loaded from beside the exe
    'vite', // development only
    // Drivers of Knex dialects IPAM does not ship (MariaDB is reached through mysql2)
    'sqlite3',
    'mysql',
    'mariadb',
    'mariadb/*',
    'oracledb',
    'pg-query-stream',
    'pg-native',
  ],
});

// 3. The executable. The embedded Node must match the one the SQLite engine
//    was built for, so build with the same major version that is running now.
writeFileSync(
  path.join(root, 'build', 'pkg.json'),
  JSON.stringify(
    {
      name: 'ipam',
      version,
      bin: 'server.cjs',
      pkg: { assets: ['../dist/**/*'] },
    },
    null,
    2,
  ),
);
run(
  `npx pkg build/server.cjs --config build/pkg.json --targets node${nodeMajor}-win-x64 ` +
    `--output "${path.join(out, 'ipam.exe')}" --no-bytecode --public --public-packages "*" --compress GZip`,
);

// 4. Files that sit beside the exe.
cpSync(path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), path.join(out, 'better_sqlite3.node'));
cpSync(path.join(root, 'installer', 'nssm.exe'), path.join(out, 'nssm.exe'));
cpSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE.txt'));
writeFileSync(
  path.join(out, 'README.txt'),
  [
    `IPAM ${version} - IP Address Management`,
    '',
    'Installed by IPAM-Setup: IPAM runs as the Windows service "IPAM" and starts with Windows.',
    '  Open:     http://localhost:3000/  (or the port chosen during setup)',
    '  Sign in:  admin / admin123 - change it under Settings > Local Users',
    '  Data:     C:\\ProgramData\\IPAM  (database, connection settings, logs)',
    '  Service:  services.msc > IPAM, or "nssm restart IPAM" from this folder',
    '',
    'Portable use (the zip): double-click ipam.exe. Data is kept in the "data" folder',
    'next to it and the browser opens on http://localhost:3000/. Set PORT to change it.',
    '',
    'Database: Settings > Database connects IPAM to PostgreSQL, MySQL / MariaDB or',
    'Microsoft SQL Server and can copy your data across.',
    '',
    'https://github.com/Benny007-king/IPAM',
    '',
  ].join('\r\n'),
);

// 5. Portable zip.
const zip = path.join(root, 'release', `IPAM-${version}-win-x64-portable.zip`);
run(`powershell -NoProfile -Command "Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}' -Force"`);

const mb = (f) => (statSync(f).size / 1048576).toFixed(1) + ' MB';
console.log(`\nBuilt IPAM ${version} with Node ${process.versions.node}:`);
console.log(`  ${path.join(out, 'ipam.exe')}  ${mb(path.join(out, 'ipam.exe'))}`);
console.log(`  ${zip}  ${mb(zip)}`);
