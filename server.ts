import express from 'express';
import { createServer as createViteServer } from 'vite';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from './database.js';
import { startPingService } from './pingService.js';
import { authenticate as ldapAuthenticate } from 'ldap-authentication';
import { Client } from 'ldapts';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

function syncIpsForSegment(segmentId: number, network: string, subnet_mask: string) {
  try {
    const ipToLong = (ip: string) => ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    const longToIp = (long: number) => [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
    
    const netLong = ipToLong(network);
    const maskLong = ipToLong(subnet_mask);
    const networkAddr = netLong & maskLong;
    const broadcastAddr = networkAddr | (~maskLong >>> 0);
    
    const maxIps = Math.min(broadcastAddr - networkAddr - 1, 65534);
    
    const validIps = new Set<string>();
    for (let i = 1; i <= maxIps; i++) {
      validIps.add(longToIp(networkAddr + i));
    }

    const existingIps = db.prepare('SELECT id, ip_address FROM ips WHERE segment_id = ?').all(segmentId) as any[];
    const existingIpSet = new Set(existingIps.map((ip: any) => ip.ip_address));

    const ipsToDelete = existingIps.filter((ip: any) => !validIps.has(ip.ip_address));
    const ipsToAdd = Array.from(validIps).filter(ip => !existingIpSet.has(ip));

    const chunkSize = 1000;
    
    const processChunks = () => {
      let deleteIndex = 0;
      let addIndex = 0;

      const processNextChunk = () => {
        db.transaction(() => {
          const deleteStmt = db.prepare('DELETE FROM ips WHERE id = ?');
          const deleteEnd = Math.min(deleteIndex + chunkSize, ipsToDelete.length);
          for (; deleteIndex < deleteEnd; deleteIndex++) {
            deleteStmt.run(ipsToDelete[deleteIndex].id);
          }

          const insertStmt = db.prepare('INSERT INTO ips (segment_id, ip_address, ip_long, status) VALUES (?, ?, ?, ?)');
          const addEnd = Math.min(addIndex + chunkSize, ipsToAdd.length);
          for (; addIndex < addEnd; addIndex++) {
            const ip = ipsToAdd[addIndex];
            insertStmt.run(segmentId, ip, ipToLong(ip), 'unknown');
          }
        })();

        if (deleteIndex < ipsToDelete.length || addIndex < ipsToAdd.length) {
          setTimeout(processNextChunk, 10); // Yield to event loop
        }
      };

      processNextChunk();
    };

    processChunks();
  } catch (e) {
    console.error(`Failed to sync IPs for segment ${segmentId}:`, e);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(cookieParser());

  // Start background ping service
  startPingService();

  // Middleware to check auth
  const requireAuth = (req: any, res: any, next: any) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid token' });
    }
  };

  const requireRole = (roles: string[]) => {
    return (req: any, res: any, next: any) => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    };
  };

  // Auth routes
  app.post('/api/auth/login', async (req, res) => {
    const { username, password, type } = req.body;

    if (type === 'local') {
      const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_local = 1').get(username) as any;
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
      res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'none' });
      return res.json({ user: { id: user.id, username: user.username, role: user.role } });
    } else {
      // LDAP Auth
      try {
        const ldapServers = db.prepare('SELECT * FROM ldap_servers').all() as any[];
        if (ldapServers.length === 0) {
          return res.status(400).json({ error: 'No LDAP servers configured' });
        }

        const adGroups = db.prepare('SELECT * FROM ad_groups').all() as any[];
        if (adGroups.length === 0) {
          return res.status(400).json({ error: 'No AD groups configured for access' });
        }

        let authenticatedUser: any = null;
        let userGroups: string[] = [];
        let lastError: Error | null = null;

        for (const server of ldapServers) {
          const addresses = server.dc_addresses.split(',').map((a: string) => a.trim());
          
          for (const address of addresses) {
            const url = `ldap://${address}:${server.port}`;
            const client = new Client({ url, timeout: 5000, connectTimeout: 5000 });
            
            try {
              // 1. Bind with service account
              await client.bind(server.service_account, server.password);
              
              // 2. Get default naming context (Search Base)
              const rootDse = await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['defaultNamingContext'] });
              const searchBase = rootDse.searchEntries[0].defaultNamingContext as string;
              
              // 3. Search for the user
              // Strip domain from username if provided (e.g., user@domain.com -> user)
              const sAMAccountName = username.split('@')[0].split('\\').pop();
              
              const searchResult = await client.search(searchBase, {
                scope: 'sub',
                filter: `(&(objectClass=user)(sAMAccountName=${sAMAccountName}))`,
                attributes: ['dn', 'memberOf']
              });

              if (searchResult.searchEntries.length === 0) {
                throw new Error('User not found in AD');
              }

              const userEntry = searchResult.searchEntries[0];
              const userDn = userEntry.dn;
              
              // 4. Verify user password by binding as the user
              const userClient = new Client({ url, timeout: 5000, connectTimeout: 5000 });
              await userClient.bind(userDn, password);
              await userClient.unbind(); // Password is correct!

              // 5. Extract groups
              authenticatedUser = userEntry;
              const memberOf = userEntry.memberOf;
              if (Array.isArray(memberOf)) {
                userGroups = memberOf.map((g: any) => {
                  const gStr = g.toString();
                  const match = gStr.match(/CN=([^,]+)/i);
                  return match ? match[1] : gStr;
                });
              } else if (memberOf) {
                const gStr = memberOf.toString();
                const match = gStr.match(/CN=([^,]+)/i);
                userGroups = match ? [match[1]] : [gStr];
              }

              await client.unbind();
              break; // Success, break out of address loop
            } catch (err: any) {
              lastError = err;
              try { await client.unbind(); } catch (e) {}
            }
          }
          if (authenticatedUser) break; // Success, break out of server loop
        }

        if (!authenticatedUser) {
          console.error('LDAP Auth failed:', lastError);
          return res.status(401).json({ error: 'Invalid LDAP credentials or user not found' });
        }

        // 6. Map AD groups to roles
        let assignedRole = '';
        const roleHierarchy: Record<string, number> = { 'admin': 3, 'editor': 2, 'readonly': 1 };
        let maxRoleValue = 0;

        for (const group of userGroups) {
          const matchedAdGroup = adGroups.find(ag => ag.group_name.toLowerCase() === group.toLowerCase());
          if (matchedAdGroup) {
            const roleValue = roleHierarchy[matchedAdGroup.role] || 0;
            if (roleValue > maxRoleValue) {
              maxRoleValue = roleValue;
              assignedRole = matchedAdGroup.role;
            }
          }
        }

        if (!assignedRole) {
          return res.status(403).json({ error: 'User does not belong to any authorized AD group' });
        }

        // 7. Create or update user in local DB
        let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
        if (!user) {
          const result = db.prepare('INSERT INTO users (username, role, is_local) VALUES (?, ?, ?)').run(username, assignedRole, 0);
          user = { id: Number(result.lastInsertRowid), username, role: assignedRole };
        } else {
          // Update role if it changed
          if (user.role !== assignedRole) {
            db.prepare('UPDATE users SET role = ? WHERE id = ?').run(assignedRole, user.id);
            user.role = assignedRole;
          }
        }

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
        res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'none' });
        return res.json({ user: { id: user.id, username: user.username, role: user.role } });

      } catch (err: any) {
        console.error('LDAP Error:', err);
        return res.status(500).json({ error: 'LDAP authentication failed due to server error' });
      }
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: true, sameSite: 'none' });
    res.json({ success: true });
  });

  app.get('/api/auth/me', requireAuth, (req: any, res) => {
    res.json({ user: req.user });
  });

  app.get('/api/search', requireAuth, (req, res) => {
    const q = req.query.q as string;
    if (!q) return res.json({ segments: [], ips: [] });
    
    const searchTerm = `%${q}%`;
    
    try {
      const segments = db.prepare(`
        SELECT * FROM segments 
        WHERE name LIKE ? OR network LIKE ? OR subnet_mask LIKE ? OR description LIKE ?
      `).all(searchTerm, searchTerm, searchTerm, searchTerm);
      
      const ips = db.prepare(`
        SELECT ips.*, segments.name as segment_name 
        FROM ips 
        JOIN segments ON ips.segment_id = segments.id
        WHERE ip_address LIKE ? OR hostname LIKE ? OR os LIKE ? OR ips.description LIKE ?
        LIMIT 50
      `).all(searchTerm, searchTerm, searchTerm, searchTerm);
      
      res.json({ segments, ips });
    } catch (err: any) {
      console.error('Error searching:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Segments API
  app.get('/api/segments', requireAuth, (req, res) => {
    const segments = db.prepare('SELECT * FROM segments').all();
    res.json(segments);
  });

  app.get('/api/segments/:id', requireAuth, (req, res) => {
    const segment = db.prepare('SELECT * FROM segments WHERE id = ?').get(req.params.id);
    if (!segment) return res.status(404).json({ error: 'Segment not found' });
    res.json(segment);
  });

  app.post('/api/segments', requireAuth, requireRole(['admin']), (req, res) => {
    const { name, network, subnet_mask, description } = req.body;
    try {
      const result = db.prepare('INSERT INTO segments (name, network, subnet_mask, description) VALUES (?, ?, ?, ?)').run(name, network, subnet_mask, description);
      const segmentId = Number(result.lastInsertRowid);

      // Auto-populate IPs asynchronously so it doesn't block the response
      setTimeout(() => syncIpsForSegment(segmentId, network, subnet_mask), 0);

      res.json({ id: segmentId, name, network, subnet_mask, description });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/segments/:id', requireAuth, requireRole(['admin']), (req, res) => {
    const { name, network, subnet_mask, description } = req.body;
    try {
      db.prepare('UPDATE segments SET name = ?, network = ?, subnet_mask = ?, description = ? WHERE id = ?').run(name, network, subnet_mask, description, Number(req.params.id));
      
      // Sync IPs asynchronously
      setTimeout(() => syncIpsForSegment(Number(req.params.id), network, subnet_mask), 0);

      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/segments/:id', requireAuth, requireRole(['admin']), (req, res) => {
    db.prepare('DELETE FROM segments WHERE id = ?').run(Number(req.params.id));
    res.json({ success: true });
  });

  // IPs API
  app.get('/api/segments/:segmentId/ips', requireAuth, (req, res) => {
    const ips = db.prepare('SELECT * FROM ips WHERE segment_id = ? ORDER BY ip_long ASC').all(Number(req.params.segmentId));
    res.json(ips);
  });

  app.post('/api/segments/:segmentId/ips', requireAuth, requireRole(['admin', 'editor']), (req: any, res) => {
    const { ip_address, hostname, os, description } = req.body;
    const segmentId = Number(req.params.segmentId);
    try {
      const ipToLong = (ipStr: string) => ipStr.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
      const result = db.prepare('INSERT INTO ips (segment_id, ip_address, ip_long, hostname, os, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        segmentId, ip_address, ipToLong(ip_address), hostname, os, description, req.user.id
      );
      const newIp = db.prepare('SELECT * FROM ips WHERE id = ?').get(Number(result.lastInsertRowid));
      res.json(newIp);
    } catch (err: any) {
      if (err.message.includes('UNIQUE constraint failed')) {
        res.status(400).json({ error: 'IP address already exists in this segment' });
      } else {
        res.status(400).json({ error: err.message });
      }
    }
  });

  app.put('/api/ips/:id', requireAuth, requireRole(['admin', 'editor']), (req, res) => {
    const { hostname, os, description } = req.body;
    try {
      db.prepare('UPDATE ips SET hostname = ?, os = ?, description = ? WHERE id = ?').run(
        hostname, os, description, Number(req.params.id)
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/ips/:id', requireAuth, requireRole(['admin', 'editor']), (req, res) => {
    db.prepare('DELETE FROM ips WHERE id = ?').run(Number(req.params.id));
    res.json({ success: true });
  });

  // Notifications API
  app.get('/api/notifications', requireAuth, (req, res) => {
    console.log('GET /api/notifications called');
    try {
      const notifications = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50').all();
      res.json(notifications);
    } catch (err: any) {
      console.error('Error fetching notifications:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
    try {
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      console.error('Error marking notification as read:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Settings API
  app.get('/api/users', requireAuth, requireRole(['admin']), (req, res) => {
    try {
      const users = db.prepare('SELECT id, username, role, is_local FROM users').all();
      res.json(users);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users', requireAuth, requireRole(['admin']), (req, res) => {
    const { username, password, role } = req.body;
    try {
      const hash = bcrypt.hashSync(password, 10);
      const result = db.prepare('INSERT INTO users (username, password_hash, role, is_local) VALUES (?, ?, ?, ?)').run(username, hash, role, 1);
      res.json({ id: Number(result.lastInsertRowid), username, role, is_local: 1 });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/users/:id', requireAuth, requireRole(['admin']), (req, res) => {
    const { username, password, role } = req.body;
    try {
      if (password) {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare('UPDATE users SET username = ?, password_hash = ?, role = ? WHERE id = ?').run(username, hash, role, Number(req.params.id));
      } else {
        db.prepare('UPDATE users SET username = ?, role = ? WHERE id = ?').run(username, role, Number(req.params.id));
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/users/:id', requireAuth, requireRole(['admin']), (req, res) => {
    try {
      db.prepare('DELETE FROM users WHERE id = ? AND username != ?').run(Number(req.params.id), 'admin');
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/ldap', requireAuth, requireRole(['admin']), (req, res) => {
    try {
      const servers = db.prepare('SELECT id, server_name, dc_addresses, port, service_account, password FROM ldap_servers').all();
      res.json(servers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/ldap', requireAuth, requireRole(['admin']), (req, res) => {
    const { server_name, dc_addresses, port, service_account, password } = req.body;
    try {
      const result = db.prepare(`
        INSERT INTO ldap_servers (server_name, dc_addresses, port, service_account, password) 
        VALUES (?, ?, ?, ?, ?)
      `).run(server_name, dc_addresses, port, service_account, password);
      res.json({ id: Number(result.lastInsertRowid), server_name, dc_addresses, port, service_account, password });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/ldap/:id', requireAuth, requireRole(['admin']), (req, res) => {
    const { server_name, dc_addresses, port, service_account, password } = req.body;
    try {
      db.prepare(`
        UPDATE ldap_servers SET server_name = ?, dc_addresses = ?, port = ?, service_account = ?, password = ? WHERE id = ?
      `).run(server_name, dc_addresses, port, service_account, password, Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/ldap/:id', requireAuth, requireRole(['admin']), (req, res) => {
    try {
      db.prepare('DELETE FROM ldap_servers WHERE id = ?').run(Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/ldap/test', requireAuth, requireRole(['admin']), async (req, res) => {
    const { dc_addresses, port, service_account, password } = req.body;
    try {
      if (!dc_addresses || !port || !service_account || !password) {
        return res.status(400).json({ error: 'Missing required fields for LDAP test' });
      }

      const addresses = dc_addresses.split(',').map((a: string) => a.trim());
      let lastError: Error | null = null;
      let success = false;

      for (const address of addresses) {
        const url = `ldap://${address}:${port}`;
        const client = new Client({ url, timeout: 5000, connectTimeout: 5000 });
        try {
          await client.bind(service_account, password);
          success = true;
          await client.unbind();
          break;
        } catch (err: any) {
          lastError = err;
          try { await client.unbind(); } catch (e) {}
        }
      }

      if (success) {
        res.json({ success: true, message: 'Connection successful' });
      } else {
        let errorMsg = 'Connection failed';
        if (lastError) {
          if (lastError.message.includes('InvalidCredentialsError') || lastError.message.includes('49')) {
            errorMsg = 'Invalid credentials (service account or password incorrect)';
          } else if (lastError.message.includes('ECONNREFUSED') || lastError.message.includes('timeout')) {
            errorMsg = 'Could not connect to the LDAP server (check address and port)';
          } else {
            errorMsg = lastError.message;
          }
        }
        res.status(400).json({ error: errorMsg });
      }
    } catch (err: any) {
      res.status(400).json({ error: 'Connection failed: ' + err.message });
    }
  });

  app.get('/api/ad-groups', requireAuth, requireRole(['admin']), (req, res) => {
    try {
      const groups = db.prepare('SELECT * FROM ad_groups').all();
      res.json(groups);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/ad-groups', requireAuth, requireRole(['admin']), (req, res) => {
    const { group_name, role } = req.body;
    try {
      const result = db.prepare('INSERT INTO ad_groups (group_name, role) VALUES (?, ?)').run(group_name, role);
      res.json({ id: Number(result.lastInsertRowid), group_name, role });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/ad-groups/:id', requireAuth, requireRole(['admin']), (req, res) => {
    const { group_name, role } = req.body;
    try {
      db.prepare('UPDATE ad_groups SET group_name = ?, role = ? WHERE id = ?').run(group_name, role, Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/ad-groups/:id', requireAuth, requireRole(['admin']), (req, res) => {
    try {
      db.prepare('DELETE FROM ad_groups WHERE id = ?').run(Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
