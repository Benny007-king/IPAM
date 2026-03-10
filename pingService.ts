import ping from 'ping';
import db from './database.js';
import { differenceInHours, differenceInDays } from 'date-fns';

export function startPingService() {
  // Run every 1 minute
  setInterval(async () => {
    const ips = db.prepare('SELECT id, ip_address, hostname, last_seen, status FROM ips').all() as any[];

    for (const ip of ips) {
      try {
        // Ping IP address
        let isAlive = false;
        try {
          const resIp = await ping.promise.probe(ip.ip_address, { timeout: 2 });
          isAlive = resIp.alive;
        } catch (e) {
          // ignore
        }

        // If IP is not alive but we have a hostname, ping the hostname
        if (!isAlive && ip.hostname) {
          try {
            const resHost = await ping.promise.probe(ip.hostname, { timeout: 2 });
            isAlive = resHost.alive;
          } catch (e) {
            // ignore
          }
        }

        const now = new Date().toISOString();

        if (isAlive) {
          // Update status to online and last_seen
          db.prepare('UPDATE ips SET status = ?, last_seen = ? WHERE id = ?').run('online', now, ip.id);
        } else {
          // Update status to offline, keep last_seen as is
          db.prepare('UPDATE ips SET status = ? WHERE id = ?').run('offline', ip.id);

          // Check for notifications if it has been seen before
          if (ip.last_seen) {
            const lastSeenDate = new Date(ip.last_seen);
            const hoursOffline = differenceInHours(new Date(), lastSeenDate);
            const daysOffline = differenceInDays(new Date(), lastSeenDate);

            if (daysOffline >= 7) {
              // Check if we already sent a 7-day notification EVER for this IP
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
              // Check if we already sent a 24-hour notification recently
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
    }
  }, 60000); // 60 seconds
}
