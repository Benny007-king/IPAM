import React, { useEffect, useState } from 'react';
import { CheckCircle, Database, Loader2, XCircle } from 'lucide-react';
import { Button } from './components/ui/Button';
import { Input } from './components/ui/Input';

type Client = 'sqlite' | 'postgres' | 'mysql' | 'mssql';
type Tls = 'off' | 'verify' | 'trust';

interface Status {
  source: 'env' | 'file' | 'default';
  configFile: string;
  defaultSqlitePath: string;
  connected: boolean;
  error?: string;
  version: string;
  config: {
    client: Client;
    label: string;
    filename?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    tls?: Tls;
    passwordSet: boolean;
  } | null;
  counts: Record<string, number> | null;
}

const CLIENTS: { id: Client; name: string; hint: string; port?: number }[] = [
  { id: 'sqlite', name: 'SQLite', hint: 'Built in — one file on this server, nothing to set up.' },
  { id: 'postgres', name: 'PostgreSQL', hint: 'Also Amazon RDS / Aurora, Azure Database, Supabase, CockroachDB.', port: 5432 },
  { id: 'mysql', name: 'MySQL / MariaDB', hint: 'MySQL 5.7+ or MariaDB 10.3+.', port: 3306 },
  { id: 'mssql', name: 'SQL Server', hint: 'SQL Server 2016+ or Azure SQL. A named instance: server\\INSTANCE.', port: 1433 },
];

const TLS_LABELS: Record<Tls, string> = {
  off: 'Off',
  verify: 'On — verify the certificate',
  trust: 'On — accept any certificate',
};

interface Form {
  client: Client;
  filename: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  tls: Tls;
  url: string;
}

const emptyForm = (client: Client = 'postgres'): Form => ({
  client,
  filename: '',
  host: '',
  port: String(CLIENTS.find((c) => c.id === client)?.port ?? ''),
  database: 'ipam',
  user: '',
  password: '',
  tls: client === 'mssql' ? 'trust' : 'off',
  url: '',
});

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}

function countsLine(c: Record<string, number> | null | undefined) {
  if (!c) return '';
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  return [plural(c.segments || 0, 'segment', 'segments'), plural(c.ips || 0, 'IP', 'IPs'), plural(c.users || 0, 'user', 'users')].join(' · ');
}

function target(cfg: Status['config'] | Form | null) {
  if (!cfg) return '';
  if (cfg.client === 'sqlite') return (cfg as any).filename || 'built-in file';
  const host = (cfg as any).host;
  const port = (cfg as any).port;
  const at = cfg.client === 'mssql' && String(host).includes('\\') ? host : `${host}:${port}`;
  return `${(cfg as any).user ? `${(cfg as any).user}@` : ''}${at}/${(cfg as any).database}`;
}

export function DatabaseSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm());
  const [useUrl, setUseUrl] = useState(false);
  const [copyData, setCopyData] = useState(true);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const r = await api('GET', '/api/settings/database');
    if (r.ok) {
      setStatus(r.data);
      setLoadError('');
    } else setLoadError(r.data.error || 'Could not read the database settings.');
  };

  useEffect(() => {
    load();
  }, []);

  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setTest(null);
  };

  const chooseClient = (client: Client) => {
    setForm((f) => {
      const oldDefault = String(CLIENTS.find((c) => c.id === f.client)?.port ?? '');
      const newDefault = String(CLIENTS.find((c) => c.id === client)?.port ?? '');
      return {
        ...f,
        client,
        port: !f.port || f.port === oldDefault ? newDefault : f.port,
        tls: client === 'mssql' ? 'trust' : f.client === 'mssql' ? 'off' : f.tls,
      };
    });
    setTest(null);
  };

  const openForm = () => {
    const cfg = status?.config;
    // Start from a different engine than the current one: that is why the form was opened.
    const next = emptyForm(cfg?.client === 'postgres' ? 'mysql' : 'postgres');
    setForm(next);
    setUseUrl(false);
    setCopyData(true);
    setTest(null);
    setMessage(null);
    setOpen(true);
  };

  const payload = () => {
    if (useUrl && form.client !== 'sqlite') return { url: form.url, password: form.password || undefined };
    if (form.client === 'sqlite') return { client: 'sqlite', filename: form.filename };
    return {
      client: form.client,
      host: form.host,
      port: form.port,
      database: form.database,
      user: form.user,
      password: form.password,
      tls: form.tls,
    };
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    const r = await api('POST', '/api/settings/database/test', { config: payload() });
    setTesting(false);
    if (!r.ok) return setTest({ ok: false, text: r.data.error || 'Connection failed.' });
    const d = r.data;
    setTest({
      ok: true,
      text: d.hasIpamData
        ? `Connected to ${d.version}. It already holds IPAM data (${countsLine(d.counts)}) — untick “copy my data” to use it as it is.`
        : `Connected to ${d.version}. The database is empty and ready for IPAM.`,
    });
  };

  const runSwitch = async () => {
    setSwitching(true);
    const r = await api('PUT', '/api/settings/database', { config: payload(), copyData });
    setSwitching(false);
    setConfirming(false);
    if (!r.ok) {
      setTest({ ok: false, text: r.data.error || 'Switching failed. IPAM is still using the previous database.' });
      return;
    }
    const d = r.data;
    let text = `IPAM now uses ${d.version}.`;
    if (d.copied) text += ` Copied ${countsLine(d.copied)}, plus LDAP servers and AD groups.`;
    if (d.seededAdmin) text += ' The new database had no users, so the default admin (admin / admin123) was created — change its password.';
    text += ' The previous database was left untouched.';
    setMessage({ ok: true, text });
    setOpen(false);
    await load();
    window.dispatchEvent(new CustomEvent('segments-updated'));
  };

  const cfg = status?.config;
  const envLocked = status?.source === 'env';
  const hint = CLIENTS.find((c) => c.id === form.client)?.hint;

  return (
    <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-semibold">Database</h2>
          <p className="text-sm text-gray-500 mt-1">Where IPAM keeps segments, IPs, users and settings.</p>
        </div>
        {!open && status && !envLocked && (
          <Button variant="outline" onClick={openForm}>
            Change database
          </Button>
        )}
      </div>

      {loadError && <div className="p-3 rounded-md bg-red-50 text-red-800 text-sm">{loadError}</div>}
      {!status && !loadError && (
        <div className="flex items-center text-sm text-gray-500">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading…
        </div>
      )}

      {status && cfg && (
        <div className="flex items-start gap-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-indigo-100">
            <Database className="h-5 w-5 text-indigo-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-gray-900">{status.version || cfg.label}</span>
              {status.connected ? (
                <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                  <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-green-500" />
                  Connected
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                  <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-red-500" />
                  Not reachable
                </span>
              )}
            </div>
            <p className="mt-1 break-all font-mono text-xs text-gray-600">
              {target(cfg)}
              {cfg.client !== 'sqlite' && ` · TLS ${cfg.tls === 'off' ? 'off' : cfg.tls === 'verify' ? 'verified' : 'any certificate'}`}
            </p>
            {status.counts && <p className="mt-1 text-sm text-gray-600">{countsLine(status.counts)}</p>}
            {status.error && <p className="mt-1 text-sm text-red-700">{status.error}</p>}
            <p className="mt-2 text-xs text-gray-500">
              {status.source === 'env' && 'Set by environment variables (DB_CLIENT / DATABASE_URL). Change them and restart IPAM to switch.'}
              {status.source === 'default' && 'The built-in SQLite database.'}
              {status.source === 'file' && (
                <>
                  Connection saved in <span className="font-mono">{status.configFile}</span>.
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {message && (
        <div className={`mt-4 flex items-start rounded-md p-3 text-sm ${message.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`} role="status">
          {message.ok ? <CheckCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />}
          {message.text}
        </div>
      )}

      {open && (
        <div className="mt-6 border-t border-gray-200 pt-6">
          <h3 className="mb-3 text-sm font-medium text-gray-900">Connect to</h3>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" role="radiogroup" aria-label="Database type">
            {CLIENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={form.client === c.id}
                onClick={() => chooseClient(c.id)}
                className={`cursor-pointer rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                  form.client === c.id ? 'border-indigo-600 bg-indigo-50 text-indigo-700 ring-1 ring-indigo-600' : 'border-gray-300 hover:bg-gray-50'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
          {hint && <p className="mt-2 text-xs text-gray-500">{hint}</p>}

          <div className="mt-5 space-y-4">
            {form.client === 'sqlite' ? (
              <div>
                <label htmlFor="db-file" className="mb-1 block text-sm font-medium text-gray-700">
                  Database file
                </label>
                <Input
                  id="db-file"
                  value={form.filename}
                  onChange={(e) => set({ filename: e.target.value })}
                  placeholder={status?.defaultSqlitePath || 'ipam.db'}
                />
                <p className="mt-1 text-xs text-gray-500">Leave empty for the built-in file. A new path creates a new, empty database file.</p>
              </div>
            ) : useUrl ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="md:col-span-2">
                  <label htmlFor="db-url" className="mb-1 block text-sm font-medium text-gray-700">
                    Connection URL
                  </label>
                  <Input
                    id="db-url"
                    value={form.url}
                    onChange={(e) => set({ url: e.target.value })}
                    placeholder={
                      form.client === 'mssql'
                        ? 'mssql://user:password@server:1433/ipam'
                        : form.client === 'mysql'
                          ? 'mysql://user:password@server:3306/ipam'
                          : 'postgres://user:password@server:5432/ipam?sslmode=require'
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label htmlFor="db-url-pass" className="mb-1 block text-sm font-medium text-gray-700">
                    Password <span className="font-normal text-gray-400">(if not in the URL)</span>
                  </label>
                  <Input id="db-url-pass" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set({ password: e.target.value })} />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
                <div className="md:col-span-4">
                  <label htmlFor="db-host" className="mb-1 block text-sm font-medium text-gray-700">
                    Server
                  </label>
                  <Input
                    id="db-host"
                    value={form.host}
                    onChange={(e) => set({ host: e.target.value })}
                    placeholder={form.client === 'mssql' ? 'sql01.corp.local or sql01\\SQLEXPRESS' : 'db.corp.local or 10.0.0.20'}
                    spellCheck={false}
                  />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="db-port" className="mb-1 block text-sm font-medium text-gray-700">
                    Port
                  </label>
                  <Input id="db-port" inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="db-name" className="mb-1 block text-sm font-medium text-gray-700">
                    Database name
                  </label>
                  <Input id="db-name" value={form.database} onChange={(e) => set({ database: e.target.value })} spellCheck={false} />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="db-user" className="mb-1 block text-sm font-medium text-gray-700">
                    User name
                  </label>
                  <Input id="db-user" value={form.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" spellCheck={false} />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="db-pass" className="mb-1 block text-sm font-medium text-gray-700">
                    Password
                  </label>
                  <Input id="db-pass" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set({ password: e.target.value })} />
                </div>
                <div className="md:col-span-3">
                  <label htmlFor="db-tls" className="mb-1 block text-sm font-medium text-gray-700">
                    Encryption (TLS)
                  </label>
                  <select
                    id="db-tls"
                    className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    value={form.tls}
                    onChange={(e) => set({ tls: e.target.value as Tls })}
                  >
                    {(Object.keys(TLS_LABELS) as Tls[]).map((t) => (
                      <option key={t} value={t}>
                        {TLS_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {form.client !== 'sqlite' && (
              <button type="button" className="cursor-pointer text-sm text-indigo-600 hover:underline" onClick={() => setUseUrl(!useUrl)}>
                {useUrl ? 'Enter the details separately' : 'Paste a connection URL instead'}
              </button>
            )}

            <p className="text-xs text-gray-500">
              The database must already exist (an empty one is enough) and the user needs permission to create tables. IPAM creates its tables on the first connection.
            </p>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-indigo-600" checked={copyData} onChange={(e) => setCopyData(e.target.checked)} />
              <span className="text-sm">
                <span className="font-medium text-gray-900">Copy my data into the new database</span>
                <span className="block text-gray-500">
                  {status?.counts ? `${countsLine(status.counts)}, LDAP servers and AD groups.` : 'Everything in the current database.'} The new database must be empty. Untick to use what is already there.
                </span>
              </span>
            </label>

            {test && (
              <div className={`flex items-start rounded-md p-3 text-sm ${test.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`} role="status">
                {test.ok ? <CheckCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />}
                {test.text}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={switching}>
                Cancel
              </Button>
              <Button type="button" variant="outline" onClick={runTest} disabled={testing || switching}>
                {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
              <Button type="button" onClick={() => setConfirming(true)} disabled={testing || switching}>
                Switch database
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="db-confirm-title">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 id="db-confirm-title" className="mb-2 text-lg font-medium text-gray-900">
              Switch to {CLIENTS.find((c) => c.id === form.client)?.name}?
            </h3>
            <p className="mb-2 break-all font-mono text-xs text-gray-600">{useUrl && form.client !== 'sqlite' ? form.url.replace(/:[^:@/]*@/, ':•••@') : target(form)}</p>
            <p className="mb-5 text-sm text-gray-600">
              {copyData
                ? 'Your data is copied into the new database first. If anything fails, IPAM stays on the current one.'
                : 'IPAM will use the data already in that database. If it is empty, a default admin (admin / admin123) is created.'}{' '}
              The current database is not changed or deleted.
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={switching}>
                Cancel
              </Button>
              <Button onClick={runSwitch} disabled={switching}>
                {switching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {switching ? (copyData ? 'Copying…' : 'Switching…') : 'Switch'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
