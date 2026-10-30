import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2, ShieldCheck, Upload, XCircle } from 'lucide-react';
import { Button } from './components/ui/Button';

interface Pending {
  file: string;
  version: string;
  size: number;
  sha256: string;
  reinstall: boolean;
  verification: 'verified' | 'unavailable';
  verificationNote: string;
  originalName: string;
  uploadedBy: string;
  uploadedAt: string;
}

interface UpgradeState {
  state: 'installing' | 'done' | 'failed' | 'unknown';
  from: string;
  target: string;
  startedAt: string;
  startedBy: string;
  finishedAt?: string;
  exitCode?: number;
  log: string;
}

interface SystemInfo {
  version: string;
  mode: 'service' | 'portable' | 'development';
  dataDir: string;
  canInstall: boolean;
  reason?: string;
  pending: Pending | null;
  upgrade: UpgradeState | null;
  latest: { version: string; url: string; page: string; publishedAt: string } | null;
  updateAvailable: boolean;
}

const MODE_LABEL: Record<SystemInfo['mode'], string> = {
  service: 'Windows service',
  portable: 'Started by hand',
  development: 'Development',
};

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** XMLHttpRequest, for an upload progress bar. */
function uploadFile(file: File, onProgress: (pct: number) => void): Promise<{ status: number; data: any }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/system/upgrade');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ status: 0, data: { error: 'The upload failed - the connection dropped.' } });
    xhr.send(file);
  });
}

export function SoftwareSettings() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<{ target: string; text: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/system');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const data: SystemInfo = await res.json();
      setInfo(data);
      setLoadError('');
      return data;
    } catch (e: any) {
      setLoadError(e.message || 'Could not read the software information.');
      return null;
    }
  };

  useEffect(() => {
    load().then((data) => {
      // Opened (or reloaded) while an upgrade runs: follow it.
      if (data?.upgrade?.state === 'installing') follow(data.upgrade.target);
    });
  }, []);

  const pickFile = (f: File | null) => {
    setFile(f);
    setError('');
    setResult(null);
  };

  const upload = async () => {
    if (!file) return;
    setError('');
    setResult(null);
    setProgress(0);
    const { status, data } = await uploadFile(file, setProgress);
    setProgress(null);
    if (status !== 200) {
      setError(data.error || `The upload failed (HTTP ${status}).`);
      return;
    }
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    await load();
  };

  const discard = async () => {
    setError('');
    const res = await fetch('/api/system/upgrade', { method: 'DELETE' });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error || 'Could not discard the file.');
    await load();
  };

  /** Wait for the service to go down, come back and report the result. */
  const follow = async (target: string) => {
    setInstalling({ target, text: 'Installing - IPAM stops, is replaced and starts again. This takes about a minute.' });
    const deadline = Date.now() + 6 * 60 * 1000;
    let sawRestart = false;
    while (Date.now() < deadline) {
      await sleep(2500);
      try {
        const res = await fetch('/api/system', { cache: 'no-store' });
        if (!res.ok) {
          sawRestart = true;
          setInstalling({ target, text: 'IPAM is restarting…' });
          continue;
        }
        const data: SystemInfo = await res.json();
        const s = data.upgrade?.state;
        if (s === 'done') {
          setInstalling(null);
          setResult({ ok: true, text: `IPAM was upgraded to ${data.version}. The page reloads now.` });
          setTimeout(() => window.location.reload(), 2000);
          return;
        }
        if (s === 'failed') {
          setInstalling(null);
          setInfo(data);
          setResult({
            ok: false,
            text: `The setup did not finish (exit code ${data.upgrade?.exitCode}). IPAM ${data.version} is running. Details: ${data.upgrade?.log}`,
          });
          return;
        }
        setInstalling({ target, text: sawRestart ? 'IPAM is back - finishing…' : 'Installing - IPAM stops, is replaced and starts again. This takes about a minute.' });
      } catch {
        sawRestart = true;
        setInstalling({ target, text: 'IPAM is restarting…' });
      }
    }
    setInstalling(null);
    setResult({ ok: false, text: `IPAM did not report back within 6 minutes. Check the IPAM service and ${info?.dataDir ?? 'the data folder'}\\upgrade\\install.log.` });
  };

  const install = async () => {
    setError('');
    setResult(null);
    const res = await fetch('/api/system/upgrade/install', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 202) {
      setError(data.error || `Could not start the upgrade (HTTP ${res.status}).`);
      return;
    }
    follow(data.target);
  };

  const p = info?.pending;
  const last = info?.upgrade;

  return (
    <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
      <div className="mb-4">
        <h2 className="text-xl font-semibold">Software &amp; Upgrade</h2>
        <p className="text-sm text-gray-500 mt-1">Upgrade IPAM by uploading the setup file of a newer release.</p>
      </div>

      {loadError && <div className="p-3 rounded-md bg-red-50 text-red-800 text-sm">{loadError}</div>}

      {info && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
          <div>
            <span className="text-gray-500">Version</span> <span className="font-semibold text-gray-900">{info.version}</span>
          </div>
          <div>
            <span className="text-gray-500">Running as</span> <span className="font-medium text-gray-900">{MODE_LABEL[info.mode]}</span>
          </div>
          <div className="min-w-0">
            <span className="text-gray-500">Data</span> <span className="font-mono text-xs text-gray-700 break-all">{info.dataDir}</span>
          </div>
          <div className="ml-auto">
            {info.updateAvailable && info.latest ? (
              <a href={info.latest.url} className="inline-flex items-center rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-200">
                {info.latest.version} is available - download the setup
              </a>
            ) : info.latest ? (
              <span className="inline-flex items-center rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">Up to date</span>
            ) : null}
          </div>
        </div>
      )}

      {last && last.state !== 'installing' && !installing && (
        <p className={`mt-3 text-sm ${last.state === 'done' ? 'text-gray-600' : 'text-red-700'}`}>
          Last upgrade: {last.from} → {last.target} by {last.startedBy}, {new Date(last.startedAt).toLocaleString()} -{' '}
          {last.state === 'done' ? 'installed.' : last.state === 'failed' ? `failed (exit code ${last.exitCode}); see ${last.log}.` : 'result unknown.'}
        </p>
      )}

      {result && (
        <div className={`mt-4 flex items-start rounded-md p-3 text-sm ${result.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`} role="status">
          {result.ok ? <CheckCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />}
          {result.text}
        </div>
      )}

      {installing && (
        <div className="mt-4 flex items-center rounded-md bg-indigo-50 p-4 text-sm text-indigo-900" role="status" aria-live="polite">
          <Loader2 className="mr-3 h-5 w-5 shrink-0 animate-spin" />
          <div>
            <div className="font-medium">Upgrading to IPAM {installing.target}</div>
            <div className="text-indigo-800">{installing.text} Keep this page open.</div>
          </div>
        </div>
      )}

      {info && !installing && (
        <>
          {!info.canInstall && <p className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-800">{info.reason}</p>}

          {p ? (
            <div className="mt-5 rounded-lg border border-gray-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900">
                    {p.reinstall ? `Reinstall IPAM ${p.version}` : `IPAM ${info.version} → ${p.version}`}
                  </div>
                  <div className="mt-1 break-all text-xs text-gray-500">
                    {p.originalName} · {mb(p.size)} · SHA-256 <span className="font-mono">{p.sha256.slice(0, 16)}…</span>
                  </div>
                </div>
                {p.verification === 'verified' ? (
                  <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-800">
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Official release
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                    <AlertTriangle className="mr-1 h-3.5 w-3.5" /> Not compared
                  </span>
                )}
              </div>
              <ul className="mt-3 space-y-1 text-sm text-gray-600">
                <li className="flex items-start"><CheckCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0 text-green-600" /> An IPAM setup file, version {p.version}{p.reinstall ? ' (the running version - it is repaired)' : ''}</li>
                <li className="flex items-start">
                  {p.verification === 'verified' ? <CheckCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0 text-green-600" /> : <AlertTriangle className="mr-2 mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
                  {p.verificationNote}
                </li>
                <li className="flex items-start"><CheckCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0 text-green-600" /> Segments, users, settings and the database connection are kept</li>
              </ul>
              <div className="mt-4 flex flex-wrap justify-end gap-3">
                <Button variant="outline" onClick={discard}>Discard</Button>
                <Button onClick={install} disabled={!info.canInstall}>Install and restart</Button>
              </div>
            </div>
          ) : (
            <div className="mt-5">
              <label htmlFor="upgrade-file" className="mb-1 block text-sm font-medium text-gray-700">
                Setup file
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id="upgrade-file"
                  ref={fileInput}
                  type="file"
                  accept=".exe"
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  className="block w-full max-w-md cursor-pointer text-sm text-gray-700 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-gray-200"
                />
                <Button onClick={upload} disabled={!file || progress !== null}>
                  {progress !== null ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  {progress === null ? 'Upload and check' : progress < 100 ? `Uploading ${progress}%` : 'Checking…'}
                </Button>
              </div>
              {progress !== null && (
                <div className="mt-3 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
                  <div className="h-full bg-indigo-600 transition-[width] duration-200" style={{ width: `${progress}%` }} />
                </div>
              )}
              <p className="mt-2 text-xs text-gray-500">
                The <span className="font-mono">IPAM-Setup-x.y.z.exe</span> of a release. It is checked before anything changes; nothing is installed until you confirm.
              </p>
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
              <XCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
