export interface User {
  id: number;
  username: string;
  role: 'admin' | 'editor' | 'readonly';
}

export interface Segment {
  id: number;
  name: string;
  network: string;
  subnet_mask: string;
  description: string;
}

export interface IP {
  id: number;
  segment_id: number;
  ip_address: string;
  hostname: string;
  os: string;
  description: string;
  status: 'online' | 'offline' | 'unknown';
  last_seen: string | null;
  created_by: number;
  created_at: string;
}

export interface Notification {
  id: number;
  ip_id: number;
  message: string;
  type: '24_hours' | '7_days';
  is_read: boolean;
  created_at: string;
}
