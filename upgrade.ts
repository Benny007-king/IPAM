// Upgrade from a file: an administrator uploads IPAM-Setup-x.y.z.exe in
// Settings > Software & Upgrade. The file is checked first (an IPAM setup, not a
// downgrade, matching the official release's checksum when that can be fetched),
// then run silently OUTSIDE the IPAM service: the setup stops the service, so a
// child process of IPAM would be killed with it. A small watchdog script waits
// for the setup and starts the service again whatever happened.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Request } from 'express';
import { appVersion, dataDir, exeDir, isPackaged } from './paths.js';

export class UpgradeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const REPO = 'Benny007-king/IPAM';
const MAX_UPLOAD = 300 * 1024 * 1024;
const MIN_UPLOAD = 1024 * 1024;
const INSTALL_GRACE_MS = 15 * 60 * 1000;

const upgradeDir = path.join(dataDir, 'upgrade');
const pendingFile = path.join(upgradeDir, 'pending.json');
const statusFile = path.join(upgradeDir, 'status.json');
const resultFile = path.join(upgradeDir, 'result.json');
const installLog = path.join(upgradeDir, 'install.log');

export type RunMode = 'service' | 'portable' | 'development';

/** How this copy of IPAM is running. Only the installed Windows service can upgrade itself. */
export function runMode(): RunMode {
  if (!isPackaged) return 'development';
  return process.env.IPAM_SERVICE === '1' && fs.existsSync(path.join(exeDir, 'unins000.exe')) ? 'service' : 'portable';
}

function installGate(): { ok: boolean; reason?: string } {
  if (process.platform !== 'win32') return { ok: false, reason: 'Upgrading from a file needs Windows.' };
  const mode = runMode();
  if (mode === 'development') return { ok: false, reason: 'This is a development copy (npm run dev). Upgrading from a file works in the installed IPAM service.' };
  if (mode === 'portable') return { ok: false, reason: 'ipam.exe was started by hand, not as the IPAM service. Run the setup file instead.' };
  return { ok: true };
}

/** -1 / 0 / 1 for dotted versions such as 1.10.0 vs 1.9.2. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function powershell(args: string[], env: Record<string, string> = {}, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { env: { ...process.env, ...env }, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(String(stdout).trim());
    });
  });
}

/** The Windows version resource of the uploaded file (path passed by environment: no quoting). */
async function versionInfo(file: string) {
  const script =
    '$v = (Get-Item -LiteralPath $env:IPAM_UPGRADE_FILE).VersionInfo; ' +
    '@{ product = $v.ProductName; company = $v.CompanyName; description = $v.FileDescription; version = $v.ProductVersion } | ConvertTo-Json -Compress';
  try {
    const out = await powershell(['-Command', script], { IPAM_UPGRADE_FILE: file }, 20000);
    const info = JSON.parse(out);
    return {
      product: String(info.product || '').trim(),
      company: String(info.company || '').trim(),
      description: String(info.description || '').trim(),
      version: String(info.version || '').trim(),
    };
  } catch {
    throw new UpgradeError(400, "Could not read the file's version information. Is it an IPAM setup file?");
  }
}

export type Verification = 'verified' | 'unavailable';

/**
 * Compare with the SHA256SUMS published with the official release of that version.
 * verified: listed there. unavailable: no internet, or that release is not published (yet).
 * A published list that does not contain the file means it was altered: refused.
 */
async function checkOfficialChecksum(version: string, sha256: string): Promise<{ verification: Verification; note: string }> {
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/download/v${version}/SHA256SUMS`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return { verification: 'unavailable', note: `There is no published v${version} release to compare with.` };
    if (!res.ok) return { verification: 'unavailable', note: `GitHub answered ${res.status}; the file could not be compared with the official release.` };
    const sums = (await res.text()).toLowerCase();
    if (!sums.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === sha256)) {
      throw new UpgradeError(400, `This file is not the official v${version} setup: its SHA-256 is not in that release's SHA256SUMS. Download it again from the releases page.`);
    }
    return { verification: 'verified', note: `Matches the official v${version} release.` };
  } catch (e) {
    if (e instanceof UpgradeError) throw e;
    return { verification: 'unavailable', note: 'This server cannot reach GitHub, so the file could not be compared with the official release.' };
  }
}

function clearOldUploads() {
  if (!fs.existsSync(upgradeDir)) return;
  for (const name of fs.readdirSync(upgradeDir)) {
    if (name.endsWith('.tmp') || /^IPAM-Setup-.*\.exe$/i.test(name)) fs.rmSync(path.join(upgradeDir, name), { force: true });
  }
}

/** Receive the uploaded setup (request body), check it and keep it as the pending upgrade. */
export async function receiveUpload(req: Request, username: string) {
  if (upgradeState()?.state === 'installing') throw new UpgradeError(409, 'An upgrade is being installed right now.');
  fs.mkdirSync(upgradeDir, { recursive: true });
  clearOldUploads();
  fs.rmSync(pendingFile, { force: true });

  const tmp = path.join(upgradeDir, `upload-${Date.now()}.tmp`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) {
          req.unpipe(out);
          out.destroy();
          reject(new UpgradeError(413, 'That file is far too large to be an IPAM setup.'));
          return;
        }
        hash.update(chunk);
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });

    if (size < MIN_UPLOAD) throw new UpgradeError(400, 'That file is too small to be an IPAM setup.');
    const head = Buffer.alloc(2);
    const fd = fs.openSync(tmp, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString('latin1') !== 'MZ') throw new UpgradeError(400, 'That is not a Windows program. Upload the IPAM-Setup-x.y.z.exe file of a release.');

    const info = await versionInfo(tmp);
    if (info.product !== 'IPAM' || info.company !== 'Benny007-king' || !/setup/i.test(info.description)) {
      throw new UpgradeError(400, `That is not an IPAM setup file (it says "${info.description || info.product || 'unknown program'}").`);
    }
    const version = info.version.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new UpgradeError(400, `Unexpected version "${info.version}" in that setup file.`);
    const cmp = compareVersions(version, appVersion);
    if (cmp < 0) {
      throw new UpgradeError(409, `That is IPAM ${version}, older than the running ${appVersion}. Downgrades are refused - uninstall first to go back (your data is kept).`);
    }

    const sha256 = hash.digest('hex');
    const check = await checkOfficialChecksum(version, sha256);
    const file = `IPAM-Setup-${version}.exe`;
    fs.renameSync(tmp, path.join(upgradeDir, file));

    const pending = {
      file,
      version,
      size,
      sha256,
      reinstall: cmp === 0,
      verification: check.verification,
      verificationNote: check.note,
      originalName: String(req.header('x-file-name') ? decodeURIComponent(String(req.header('x-file-name'))) : file).slice(0, 200),
      uploadedBy: username,
      uploadedAt: new Date().toISOString(),
    };
    fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2));
    console.log(`Upgrade file IPAM ${version} uploaded by ${username} (${check.verification}).`);
    return pending;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function discardPending() {
  if (upgradeState()?.state === 'installing') throw new UpgradeError(409, 'An upgrade is being installed right now.');
  clearOldUploads();
  fs.rmSync(pendingFile, { force: true });
}

function pending() {
  const p = readJson(pendingFile);
  return p && fs.existsSync(path.join(upgradeDir, p.file)) ? p : null;
}

/** Run the pending setup silently, outside the service. */
export async function installPending(username: string) {
  const gate = installGate();
  if (!gate.ok) throw new UpgradeError(409, gate.reason!);
  const p = pending();
  if (!p) throw new UpgradeError(404, 'Upload the setup file first.');
  if (upgradeState()?.state === 'installing') throw new UpgradeError(409, 'An upgrade is being installed right now.');

  const script = path.join(upgradeDir, 'run-upgrade.ps1');
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  fs.writeFileSync(
    script,
    [
      '# Written by IPAM for one upgrade. Runs outside the IPAM service.',
      "$ErrorActionPreference = 'Continue'",
      `$dir = ${q(upgradeDir)}`,
      `$setup = Join-Path $dir ${q(p.file)}`,
      `$log = ${q(installLog)}`,
      '$code = -1',
      'try {',
      '  $p = Start-Process -FilePath $setup -ArgumentList @(\'/VERYSILENT\', \'/SUPPRESSMSGBOXES\', \'/NORESTART\', "/LOG=`"$log`"") -PassThru',
      '  if ($p.WaitForExit(900000)) { $code = $p.ExitCode } else { $code = -3 }',
      '} catch { $code = -2 }',
      '# Whatever happened, IPAM must be running again.',
      'Start-Sleep -Seconds 3',
      '$svc = Get-Service -Name IPAM -ErrorAction SilentlyContinue',
      "if ($svc -and $svc.Status -ne 'Running') { Start-Service -Name IPAM -ErrorAction SilentlyContinue }",
      '# The setup file is not needed any more (upload it again to retry).',
      'Remove-Item -LiteralPath $setup, (Join-Path $dir \'pending.json\') -Force -ErrorAction SilentlyContinue',
      "$json = @{ exitCode = $code; finishedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
      "[IO.File]::WriteAllText((Join-Path $dir 'result.json'), $json)",
      '',
    ].join('\r\n'),
  );
  fs.rmSync(resultFile, { force: true });
  fs.writeFileSync(
    statusFile,
    JSON.stringify({ from: appVersion, target: p.version, file: p.file, startedBy: username, startedAt: new Date().toISOString() }, null, 2),
  );

  // Win32_Process.Create starts the watchdog as a child of WMI, not of IPAM, so
  // stopping the service (which ends IPAM's whole process tree) does not end it.
  const inner = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`;
  const outer =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(inner)} }; ` +
    'exit [int]$r.ReturnValue';
  try {
    await powershell(['-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')]);
  } catch (e: any) {
    fs.rmSync(statusFile, { force: true });
    throw new UpgradeError(500, `Could not start the setup: ${e.message}`);
  }
  console.log(`Upgrade to IPAM ${p.version} started by ${username}; the service restarts shortly.`);
  return { target: p.version };
}

/** The last upgrade, if any: installing, done or failed. */
export function upgradeState() {
  const status = readJson(statusFile);
  if (!status) return null;
  const result = readJson(resultFile);
  if (!result) {
    const age = Date.now() - Date.parse(status.startedAt);
    return { ...status, state: age < INSTALL_GRACE_MS ? 'installing' : 'unknown', log: installLog };
  }
  const ok = Number(result.exitCode) === 0 && compareVersions(appVersion, status.target) === 0;
  return { ...status, state: ok ? 'done' : 'failed', exitCode: result.exitCode, finishedAt: result.finishedAt, log: installLog };
}

/** At start-up: after a successful upgrade the setup file is no longer needed. */
export function cleanupAfterUpgrade() {
  const s = upgradeState();
  if (s?.state === 'done') {
    clearOldUploads();
    fs.rmSync(pendingFile, { force: true });
    console.log(`Upgraded from IPAM ${s.from} to ${s.target}.`);
  }
}

/* The newest published release, checked at most once an hour (no internet: null). */
let latestCache: { at: number; value: any } | null = null;
async function latestRelease() {
  if (latestCache && Date.now() - latestCache.at < 3600_000) return latestCache.value;
  let value: any = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `IPAM/${appVersion}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const rel: any = await res.json();
      const asset = (rel.assets || []).find((a: any) => /^IPAM-Setup-.*\.exe$/i.test(a.name));
      value = {
        version: String(rel.tag_name || '').replace(/^v/, ''),
        url: asset?.browser_download_url || rel.html_url,
        page: rel.html_url,
        publishedAt: rel.published_at,
      };
    }
  } catch {
    /* offline */
  }
  latestCache = { at: Date.now(), value };
  return value;
}

export async function systemInfo() {
  const gate = installGate();
  const latest = await latestRelease();
  return {
    version: appVersion,
    mode: runMode(),
    dataDir,
    canInstall: gate.ok,
    reason: gate.reason,
    pending: pending(),
    upgrade: upgradeState(),
    latest,
    updateAvailable: !!latest?.version && compareVersions(latest.version, appVersion) > 0,
  };
}
