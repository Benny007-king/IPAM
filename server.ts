import express from 'express';
import { createServer as createViteServer } from 'vite';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from './database.js';
import { startPingService } from './pingService.js';
import { authenticate as ldapAuthenticate } from 'ldap-authentication';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

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
        // Mock LDAP for this example if no real LDAP server is provided
        // In a real scenario, use ldapAuthenticate
        /*
        const ldapUser = await ldapAuthenticate({
          ldapOpts: { url: 'ldap://your-ldap-server' },
          userDn: `uid=${username},ou=users,dc=example,dc=com`,
          userPassword: password,
          userSearchBase: 'ou=users,dc=example,dc=com',
          usernameAttribute: 'uid',
          username: username
        });
        */
        
        // Mocking LDAP success for demonstration
        if (username === 'ldapuser' && password === 'password') {
          // Check if user exists in DB, if not create with default role
          let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
          if (!user) {
            const result = db.prepare('INSERT INTO users (username, role, is_local) VALUES (?, ?, ?)').run(username, 'readonly', 0);
            user = { id: result.lastInsertRowid, username, role: 'readonly' };
          }

          const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
          res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'none' });
          return res.json({ user: { id: user.id, username: user.username, role: user.role } });
        } else {
          return res.status(401).json({ error: 'Invalid LDAP credentials' });
        }
      } catch (err) {
        return res.status(401).json({ error: 'LDAP authentication failed' });
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
      res.json({ id: result.lastInsertRowid, name, network, subnet_mask, description });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/segments/:id', requireAuth, requireRole(['admin']), (req, res) => {
    const { name, network, subnet_mask, description } = req.body;
    try {
      db.prepare('UPDATE segments SET name = ?, network = ?, subnet_mask = ?, description = ? WHERE id = ?').run(name, network, subnet_mask, description, req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/segments/:id', requireAuth, requireRole(['admin']), (req, res) => {
    db.prepare('DELETE FROM segments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // IPs API
  app.get('/api/segments/:segmentId/ips', requireAuth, (req, res) => {
    const ips = db.prepare('SELECT * FROM ips WHERE segment_id = ?').all(req.params.segmentId);
    res.json(ips);
  });

  app.post('/api/segments/:segmentId/ips', requireAuth, requireRole(['admin', 'editor']), (req: any, res) => {
    const { ip_address, hostname, os, description } = req.body;
    const segmentId = req.params.segmentId;
    try {
      const result = db.prepare('INSERT INTO ips (segment_id, ip_address, hostname, os, description, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
        segmentId, ip_address, hostname, os, description, req.user.id
      );
      const newIp = db.prepare('SELECT * FROM ips WHERE id = ?').get(result.lastInsertRowid);
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
    const { ip_address, hostname, os, description } = req.body;
    try {
      db.prepare('UPDATE ips SET ip_address = ?, hostname = ?, os = ?, description = ? WHERE id = ?').run(
        ip_address, hostname, os, description, req.params.id
      );
      res.json({ success: true });
    } catch (err: any) {
      if (err.message.includes('UNIQUE constraint failed')) {
        res.status(400).json({ error: 'IP address already exists in this segment' });
      } else {
        res.status(400).json({ error: err.message });
      }
    }
  });

  app.delete('/api/ips/:id', requireAuth, requireRole(['admin', 'editor']), (req, res) => {
    db.prepare('DELETE FROM ips WHERE id = ?').run(req.params.id);
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
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Error marking notification as read:', err);
      res.status(500).json({ error: err.message });
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
