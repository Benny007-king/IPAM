import ping from 'ping';
import { differenceInHours, differenceInMinutes } from 'date-fns';
import { db, isDbReady } from './db.js';

const CHUNK_SIZE = 50;
const INTERVAL_MS = 60_000;

async function probe(target: string): Promise<boolean> {
  try {
    const res = await ping.promise.probe(target, { timeout: 1 });
    return !!res.alive;
  } catch {
    return false;
  }
}

async function runPing() {
  let lastId = 0;
  for (;;) {
    if (!isDbReady()) return; // database unavailable or being switched — try again next minute
    const chunk = await db('ips')
      .select('id', 'ip_address', 'hostname', 'status', 'offline_since', 'notification_count', 'mute_notifications')
      .where('id', '>', lastId)
      .orderBy('id')
      .limit(CHUNK_SIZE);
    if (chunk.length === 0) return;
    lastId = Number(chunk[chunk.length - 1].id);

    const results = await Promise.all(
      chunk.map(async (ip: any) => {
        let alive = await probe(ip.ip_address);
        if (!alive && ip.hostname) alive = await probe(ip.hostname);
        return { ip, alive };
      }),
    );

    if (!isDbReady()) return;
    const now = new Date();
    const nowIso = now.toISOString();

    await db.transaction(async (trx) => {
      for (const { ip, alive } of results) {
        if (alive) {
          await trx('ips')
            .where({ id: ip.id })
            .update({ status: 'online', last_seen: nowIso, offline_since: null, notification_count: 0 });
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
  }
}

export function startPingService() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runPing();
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
