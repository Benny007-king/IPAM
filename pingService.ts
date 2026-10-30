import ping from 'ping';
import { differenceInHours, differenceInMinutes } from 'date-fns';
import { db, isDbReady } from './db.js';

const ROUND_CHUNK = 50; // addresses pinged at once by the background round
const REFRESH_CHUNK = 100; // addresses pinged at once by a manual refresh
const INTERVAL_MS = 60_000;
const IP_COLUMNS = ['id', 'ip_address', 'hostname', 'status', 'offline_since', 'notification_count', 'mute_notifications'];

// Addresses being pinged right now. The background round and a manual refresh
// skip each other's addresses, so an address is never processed twice at once
// (which could raise the same offline alert twice).
const inFlight = new Set<number>();

async function probe(target: string): Promise<boolean> {
  try {
    const res = await ping.promise.probe(target, { timeout: 1 });
    return !!res.alive;
  } catch {
    return false;
  }
}

/** Ping these addresses (all at once), store the results and raise offline alerts. Returns how many were checked. */
async function pingRows(rows: any[]): Promise<number> {
  const mine = rows.filter((r) => !inFlight.has(Number(r.id)));
  mine.forEach((r) => inFlight.add(Number(r.id)));
  try {
    const results = await Promise.all(
      mine.map(async (ip) => {
        let alive = await probe(ip.ip_address);
        if (!alive && ip.hostname) alive = await probe(ip.hostname);
        return { ip, alive };
      }),
    );
    if (!isDbReady() || results.length === 0) return 0;

    const now = new Date();
    const nowIso = now.toISOString();
    await db.transaction(async (trx) => {
      for (const { ip, alive } of results) {
        if (alive) {
          await trx('ips').where({ id: ip.id }).update({ status: 'online', last_seen: nowIso, offline_since: null, notification_count: 0 });
          continue;
        }
        if (ip.status === 'online') {
          // Just went offline: start the clock.
          await trx('ips').where({ id: ip.id }).update({ status: 'offline', offline_since: nowIso, notification_count: 0 });
          continue;
        }
        if (ip.status !== 'offline') await trx('ips').where({ id: ip.id }).update({ status: 'offline' });
        if (!ip.offline_since || Number(ip.mute_notifications)) continue;

        // 1st alert after 5 minutes, then one a day for up to 6 more days.
        const since = new Date(ip.offline_since);
        const count = Number(ip.notification_count) || 0;
        let message = '';
        if (count === 0 && differenceInMinutes(now, since) >= 5) {
          message = `IP ${ip.ip_address} has been offline for 5 minutes.`;
        } else if (count >= 1 && count < 7 && differenceInHours(now, since) >= count * 24) {
          message = `IP ${ip.ip_address} has been offline for ${count * 24} hours.`;
        }
        if (message) {
          await trx('notifications').insert({ ip_id: ip.id, message, type: 'offline_alert', is_read: 0, created_at: nowIso });
          await trx('ips').where({ id: ip.id }).update({ notification_count: count + 1 });
        }
      }
    });
    return results.length;
  } finally {
    mine.forEach((r) => inFlight.delete(Number(r.id)));
  }
}

/** Walk the whole ips table in id order, a chunk at a time. */
async function forEachChunk(size: number, segmentId: number | null, fn: (rows: any[]) => Promise<number>) {
  let lastId = 0;
  let total = 0;
  for (;;) {
    if (!isDbReady()) break; // database unavailable or being switched
    const q = db('ips').select(IP_COLUMNS).where('id', '>', lastId).orderBy('id').limit(size);
    if (segmentId !== null) q.andWhere({ segment_id: segmentId });
    const rows = await q;
    if (rows.length === 0) break;
    lastId = Number(rows[rows.length - 1].id);
    total += await fn(rows);
  }
  return total;
}

/** Ping one segment now (the Refresh button). Resolves with the number of addresses checked. */
export async function refreshSegment(segmentId: number): Promise<number> {
  return forEachChunk(REFRESH_CHUNK, segmentId, pingRows);
}

export function startPingService() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await forEachChunk(ROUND_CHUNK, null, pingRows);
    } catch (e: any) {
      // Never let a failed round take the server down; the next round retries.
      console.error('Ping round failed:', e?.message || e);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, INTERVAL_MS);
}
