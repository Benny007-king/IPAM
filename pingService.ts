import ping from 'ping';
import db from './database.js';
import { differenceInHours, differenceInDays } from 'date-fns';

export function startPingService() {
  let isRunning = false;

  const runPing = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const ips = db.prepare('SELECT id, ip_address, hostname, last_seen, status FROM ips').all() as any[];
      const chunkSize = 50;
      
      for (let i = 0; i < ips.length; i += chunkSize) {
        const chunk = ips.slice(i, i + chunkSize);
        
        await Promise.all(chunk.map(async (ip) => {
          try {
            let isAlive = false;
            try {
              const resIp = await ping.promise.probe(ip.ip_address, { timeout: 1 });
              isAlive = resIp.alive;
            } catch (e) {
              // ignore
            }

            if (!isAlive && ip.hostname) {
              try {
                const resHost = await ping.promise.probe(ip.hostname, { timeout: 1 });
                isAlive = resHost.alive;
              } catch (e) {
                // ignore
              }
            }

            const now = new Date().toISOString();

            if (isAlive) {
              db.prepare('UPDATE ips SET status = ?, last_seen = ? WHERE id = ?').run('online', now, ip.id);
            } else {
              db.prepare('UPDATE ips SET status = ? WHERE id = ?').run('offline', ip.id);

              if (ip.last_seen) {
                const lastSeenDate = new Date(ip.last_seen);
                const hoursOffline = differenceInHours(new Date(), lastSeenDate);
                const daysOffline = differenceInDays(new Date(), lastSeenDate);

                if (daysOffline >= 7) {
                  const existingNotif = db.prepare(`
                    SELECT id FROM notifications 
                    WHERE ip_id = ? AND type = '7_days'
                  `).get(ip.id);

                  if (!existingNotif) {
                    db.prepare('INSERT INTO notifications (ip_id, message, type) VALUES (?, ?, ?)').run(
                      ip.id,
                      `IP ${ip.ip_address} has not responded for 7 days. Recommendation: Delete this IP.`,
                      '7_days'
                    );
                  }
                } else if (hoursOffline >= 24) {
                  const recentNotif = db.prepare(`
                    SELECT id FROM notifications 
                    WHERE ip_id = ? AND type = '24_hours' AND created_at > datetime('now', '-1 day')
                  `).get(ip.id);

                  if (!recentNotif) {
                    db.prepare('INSERT INTO notifications (ip_id, message, type) VALUES (?, ?, ?)').run(
                      ip.id,
                      `IP ${ip.ip_address} has not responded for 24 hours.`,
                      '24_hours'
                    );
                  }
                }
              }
            }
          } catch (error) {
            console.error(`Failed to ping ${ip.ip_address}:`, error);
          }
        }));
      }
    } finally {
      isRunning = false;
    }
  };

  // Run immediately
  runPing();

  // Run every 1 minute
  setInterval(runPing, 60000);
}
