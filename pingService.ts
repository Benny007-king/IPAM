import ping from 'ping';
import db from './database.js';
import { differenceInHours, differenceInDays } from 'date-fns';

export function startPingService() {
  let isRunning = false;

  const runPing = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const chunkSize = 50;
      let offset = 0;
      
      const updateOnline = db.prepare('UPDATE ips SET status = ?, last_seen = ? WHERE id = ?');
      const updateOffline = db.prepare('UPDATE ips SET status = ? WHERE id = ?');
      const insertNotif = db.prepare('INSERT INTO notifications (ip_id, message, type) VALUES (?, ?, ?)');
      const checkNotif7Days = db.prepare(`SELECT id FROM notifications WHERE ip_id = ? AND type = '7_days'`);
      const checkNotif24Hours = db.prepare(`SELECT id FROM notifications WHERE ip_id = ? AND type = '24_hours' AND created_at > datetime('now', '-1 day')`);

      while (true) {
        const chunk = db.prepare('SELECT id, ip_address, hostname, last_seen, status FROM ips LIMIT ? OFFSET ?').all(chunkSize, offset) as any[];
        if (chunk.length === 0) break;
        
        const results = await Promise.all(chunk.map(async (ip) => {
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
            return { ip, isAlive };
          } catch (error) {
            console.error(`Failed to ping ${ip.ip_address}:`, error);
            return { ip, isAlive: false, error: true };
          }
        }));

        // Process DB updates for this chunk synchronously in a transaction
        db.transaction(() => {
          const now = new Date().toISOString();
          
          for (const { ip, isAlive, error } of results) {
            if (error) continue;

            if (isAlive) {
              updateOnline.run('online', now, ip.id);
            } else {
              updateOffline.run('offline', ip.id);

              if (ip.last_seen) {
                const lastSeenDate = new Date(ip.last_seen);
                const hoursOffline = differenceInHours(new Date(), lastSeenDate);
                const daysOffline = differenceInDays(new Date(), lastSeenDate);

                if (daysOffline >= 7) {
                  const existingNotif = checkNotif7Days.get(ip.id);
                  if (!existingNotif) {
                    insertNotif.run(ip.id, `IP ${ip.ip_address} has not responded for 7 days. Recommendation: Delete this IP.`, '7_days');
                  }
                } else if (hoursOffline >= 24) {
                  const recentNotif = checkNotif24Hours.get(ip.id);
                  if (!recentNotif) {
                    insertNotif.run(ip.id, `IP ${ip.ip_address} has not responded for 24 hours.`, '24_hours');
                  }
                }
              }
            }
          }
        })();
        
        offset += chunkSize;
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
