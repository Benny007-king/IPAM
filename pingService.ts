import ping from 'ping';
import db from './database.js';
import { differenceInHours, differenceInDays, differenceInMinutes } from 'date-fns';

export function startPingService() {
  let isRunning = false;

  const runPing = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const chunkSize = 50;
      let offset = 0;
      
      const updateOnline = db.prepare('UPDATE ips SET status = ?, last_seen = ?, offline_since = NULL, notification_count = 0 WHERE id = ?');
      const updateOffline = db.prepare('UPDATE ips SET status = ? WHERE id = ?');
      const setOfflineSince = db.prepare('UPDATE ips SET offline_since = ?, notification_count = 0 WHERE id = ?');
      const updateNotifCount = db.prepare('UPDATE ips SET notification_count = ? WHERE id = ?');
      const insertNotif = db.prepare('INSERT INTO notifications (ip_id, message, type) VALUES (?, ?, ?)');

      while (true) {
        const chunk = db.prepare('SELECT id, ip_address, hostname, last_seen, status, offline_since, notification_count, mute_notifications FROM ips LIMIT ? OFFSET ?').all(chunkSize, offset) as any[];
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
          const now = new Date();
          const nowIso = now.toISOString();
          
          for (const { ip, isAlive, error } of results) {
            if (error) continue;

            if (isAlive) {
              updateOnline.run('online', nowIso, ip.id);
            } else {
              updateOffline.run('offline', ip.id);

              if (ip.status === 'online') {
                // Just went offline
                setOfflineSince.run(nowIso, ip.id);
              } else if (ip.offline_since && !ip.mute_notifications) {
                const offlineDate = new Date(ip.offline_since);
                const minsOffline = differenceInMinutes(now, offlineDate);
                const hoursOffline = differenceInHours(now, offlineDate);
                const notifCount = ip.notification_count || 0;

                if (notifCount === 0 && minsOffline >= 5) {
                  insertNotif.run(ip.id, `IP ${ip.ip_address} has been offline for 5 minutes.`, 'offline_alert');
                  updateNotifCount.run(1, ip.id);
                } else if (notifCount >= 1 && notifCount < 7) {
                  // Next alert after 24 hours since the last threshold
                  // 1st notif = 5 mins
                  // 2nd notif = 24 hours
                  // 3rd notif = 48 hours
                  // ...
                  const requiredHours = notifCount * 24;
                  if (hoursOffline >= requiredHours) {
                    insertNotif.run(ip.id, `IP ${ip.ip_address} has been offline for ${requiredHours} hours.`, 'offline_alert');
                    updateNotifCount.run(notifCount + 1, ip.id);
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
