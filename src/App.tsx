import React, { useState, useEffect, createContext, useContext } from 'react';
import { User, Segment, IP, Notification } from './types';
import { Button } from './components/ui/Button';
import { Input } from './components/ui/Input';
import { Activity, Bell, LogOut, Network, Plus, Server, Trash2, Users, AlertTriangle, Edit2, X, Settings } from 'lucide-react';

// Auth Context
const AuthContext = createContext<{
  user: User | null;
  login: (user: User) => void;
  logout: () => void;
}>({ user: null, login: () => {}, logout: () => {} });

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async res => {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch (e) {
          console.error('Invalid JSON from /api/auth/me:', text.substring(0, 50));
          return {};
        }
      })
      .then(data => {
        if (data && data.user) setUser(data.user);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = (u: User) => setUser(u);
  const logout = () => {
    fetch('/api/auth/logout', { method: 'POST' }).then(() => setUser(null));
  };

  if (loading) return <div className="flex h-screen items-center justify-center">Loading...</div>;

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Login Component
function Login() {
  const { login } = useContext(AuthContext);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [type, setType] = useState<'ldap' | 'local'>('ldap');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, type }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('Invalid response from server');
      }
      if (res.ok) {
        login(data.user);
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (err) {
      setError('Network error');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8 rounded-xl bg-white p-10 shadow-lg">
        <div>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100">
            <Network className="h-6 w-6 text-indigo-600" />
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">IPAM System</h2>
          <p className="mt-2 text-center text-sm text-gray-600">Sign in to manage your IP addresses</p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="flex justify-center space-x-4 mb-4">
            <Button
              type="button"
              variant={type === 'ldap' ? 'default' : 'outline'}
              onClick={() => setType('ldap')}
              className="w-full"
            >
              LDAP Login
            </Button>
            <Button
              type="button"
              variant={type === 'local' ? 'default' : 'outline'}
              onClick={() => setType('local')}
              className="w-full"
            >
              Local Admin
            </Button>
          </div>
          {error && <div className="text-red-500 text-sm text-center bg-red-50 p-2 rounded">{error}</div>}
          <div className="space-y-4 rounded-md shadow-sm">
            <div>
              <label className="sr-only">Username</label>
              <Input
                type="text"
                required
                placeholder="Username"
                value={username}
                onChange={e => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label className="sr-only">Password</label>
              <Input
                type="password"
                required
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
          </div>
          <Button type="submit" className="w-full">Sign in</Button>
        </form>
      </div>
    </div>
  );
}

function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ segments: Segment[], ips: (IP & { segment_name: string })[] }>({ segments: [], ips: [] });
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!query) {
      setResults({ segments: [], ips: [] });
      setIsOpen(false);
      return;
    }

    const delayDebounceFn = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
          setResults(data);
          setIsOpen(true);
        })
        .catch(console.error);
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [query]);

  const handleSelectSegment = (segmentId: number) => {
    window.dispatchEvent(new CustomEvent('navigate-segment', { detail: { segmentId } }));
    setIsOpen(false);
    setQuery('');
  };

  return (
    <div className="relative w-full max-w-lg mx-auto">
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <svg className="h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
        </div>
        <input
          type="text"
          className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          placeholder="Search IPs, Hostnames, Segments..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { if (query) setIsOpen(true); }}
          onBlur={() => setTimeout(() => setIsOpen(false), 200)}
        />
      </div>

      {isOpen && (results.segments.length > 0 || results.ips.length > 0) && (
        <div className="absolute mt-1 w-full bg-white shadow-lg rounded-md border border-gray-200 z-50 max-h-96 overflow-y-auto">
          {results.segments.length > 0 && (
            <div className="p-2">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">Segments</h3>
              {results.segments.map(segment => (
                <div
                  key={`seg-${segment.id}`}
                  className="px-2 py-2 hover:bg-indigo-50 cursor-pointer rounded-md"
                  onClick={() => handleSelectSegment(segment.id)}
                >
                  <div className="text-sm font-medium text-gray-900">{segment.name}</div>
                  <div className="text-xs text-gray-500">{segment.network} / {segment.subnet_mask}</div>
                </div>
              ))}
            </div>
          )}
          
          {results.ips.length > 0 && (
            <div className="p-2 border-t border-gray-100">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">IP Addresses</h3>
              {results.ips.map(ip => (
                <div
                  key={`ip-${ip.id}`}
                  className="px-2 py-2 hover:bg-indigo-50 cursor-pointer rounded-md"
                  onClick={() => handleSelectSegment(ip.segment_id)}
                >
                  <div className="flex justify-between items-center">
                    <div className="text-sm font-medium text-gray-900">{ip.ip_address}</div>
                    <div className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{ip.segment_name}</div>
                  </div>
                  <div className="text-xs text-gray-500">
                    {ip.hostname && <span className="mr-2">Host: {ip.hostname}</span>}
                    {ip.os && <span>OS: {ip.os}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Dashboard Layout
function Dashboard({ children, currentView, onNavigate }: { children: React.ReactNode, currentView: string, onNavigate: (view: string) => void }) {
  const { user, logout } = useContext(AuthContext);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);

  useEffect(() => {
    const fetchNotifs = () => {
      fetch('/api/notifications')
        .then(async res => {
          const text = await res.text();
          try {
            return JSON.parse(text);
          } catch (e) {
            console.error('Invalid JSON from /api/notifications:', text.substring(0, 50));
            return [];
          }
        })
        .then(data => {
          if (Array.isArray(data)) {
            setNotifications(data);
          } else {
            console.error('Expected array of notifications, got:', data);
            setNotifications([]);
          }
        })
        .catch(err => {
          console.error('Error fetching notifications:', err);
          setNotifications([]);
        });
    };
    fetchNotifs();
    const interval = setInterval(fetchNotifs, 60000);
    return () => clearInterval(interval);
  }, []);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  const markAsRead = async (id: number) => {
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    setNotifications(notifications.map(n => n.id === id ? { ...n, is_read: true } : n));
  };

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <div className="w-64 bg-slate-900 text-white flex flex-col">
        <div className="flex h-16 items-center px-6 border-b border-slate-800">
          <Network className="h-6 w-6 text-indigo-400 mr-2" />
          <span className="text-lg font-bold">IPAM System</span>
        </div>
        <nav className="flex-1 px-4 py-6 space-y-2">
          <a href="#" onClick={(e) => { e.preventDefault(); onNavigate('segments'); }} className={`flex items-center px-2 py-2 text-sm font-medium rounded-md ${currentView === 'segments' ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}>
            <Server className="mr-3 h-5 w-5 text-slate-400" />
            Segments
          </a>
        </nav>
        <div className="p-4 border-t border-slate-800">
          <a href="#" onClick={(e) => { e.preventDefault(); onNavigate('settings'); }} className={`flex items-center px-2 py-2 mb-4 text-sm font-medium rounded-md ${currentView === 'settings' ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}>
            <Settings className="mr-3 h-5 w-5 text-slate-400" />
            Settings
          </a>
          <div className="flex items-center">
            <div className="ml-3">
              <p className="text-sm font-medium text-white">{user?.username}</p>
              <p className="text-xs font-medium text-slate-400 capitalize">Role: {user?.role}</p>
            </div>
          </div>
          <Button variant="ghost" className="mt-4 w-full justify-start text-slate-300 hover:text-white hover:bg-slate-800" onClick={logout}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between bg-white px-6 shadow-sm z-10">
          <h1 className="text-xl font-semibold text-gray-800">
            {currentView === 'segments' ? 'Network Segments' : 'Settings'}
          </h1>
          <div className="flex-1 max-w-2xl mx-8">
            <GlobalSearch />
          </div>
          <div className="relative">
            <button 
              className="p-2 text-gray-400 hover:text-gray-500 relative"
              onClick={() => setShowNotifs(!showNotifs)}
            >
              <Bell className="h-6 w-6" />
              {unreadCount > 0 && (
                <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                  {unreadCount}
                </span>
              )}
            </button>
            
            {showNotifs && (
              <div className="absolute right-0 mt-2 w-80 rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5">
                <div className="p-3 border-b border-gray-100 font-medium text-sm">Notifications</div>
                <div className="max-h-96 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="p-4 text-sm text-gray-500 text-center">No notifications</div>
                  ) : (
                    notifications.map(n => (
                      <div key={n.id} className={`p-3 border-b border-gray-50 text-sm ${n.is_read ? 'bg-white' : 'bg-blue-50'}`}>
                        <div className="flex items-start">
                          <AlertTriangle className={`h-4 w-4 mr-2 mt-0.5 ${n.type === '7_days' ? 'text-red-500' : 'text-amber-500'}`} />
                          <div className="flex-1">
                            <p className="text-gray-800">{n.message}</p>
                            <p className="text-xs text-gray-500 mt-1">{new Date(n.created_at).toLocaleString()}</p>
                          </div>
                        </div>
                        {!n.is_read && (
                          <button onClick={() => markAsRead(n.id)} className="text-xs text-indigo-600 mt-2 hover:underline">
                            Mark as read
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </header>
        <main className="flex-1 overflow-y-auto bg-gray-100 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

// Segments View
import { SettingsView } from './SettingsView';

function SegmentsView() {
  const { user } = useContext(AuthContext);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedSegment, setSelectedSegment] = useState<Segment | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingSegment, setEditingSegment] = useState<Segment | null>(null);
  const [segmentToDelete, setSegmentToDelete] = useState<Segment | null>(null);
  const [newSegment, setNewSegment] = useState({ name: '', network: '', subnet_mask: '', description: '' });
  const [error, setError] = useState('');

  useEffect(() => {
    fetchSegments();
  }, []);

  useEffect(() => {
    const handleNavigate = (e: any) => {
      const segId = e.detail.segmentId;
      const seg = segments.find(s => s.id === segId);
      if (seg) {
        setSelectedSegment(seg);
      } else {
        // If segment is not in the current list, fetch it
        fetch(`/api/segments/${segId}`)
          .then(res => res.json())
          .then(data => {
            if (data && !data.error) {
              setSelectedSegment(data);
            }
          })
          .catch(console.error);
      }
    };
    window.addEventListener('navigate-segment', handleNavigate);
    return () => window.removeEventListener('navigate-segment', handleNavigate);
  }, [segments]);

  const fetchSegments = () => {
    fetch('/api/segments')
      .then(async res => {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch (e) {
          console.error('Invalid JSON from /api/segments:', text.substring(0, 50));
          return [];
        }
      })
      .then(data => {
        if (Array.isArray(data)) {
          setSegments(data);
        } else {
          console.error('Expected array of segments, got:', data);
          setSegments([]);
        }
      })
      .catch(err => {
        console.error('Error fetching segments:', err);
        setSegments([]);
      });
  };

  const handleAddSegment = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (editingSegment) {
      const res = await fetch(`/api/segments/${editingSegment.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSegment),
      });
      if (res.ok) {
        setNewSegment({ name: '', network: '', subnet_mask: '', description: '' });
        setShowAdd(false);
        setEditingSegment(null);
        fetchSegments();
      } else {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          setError(data.error || 'Failed to update segment');
        } catch (e) {
          setError('Failed to update segment (Server error)');
        }
      }
    } else {
      const res = await fetch('/api/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSegment),
      });
      if (res.ok) {
        setNewSegment({ name: '', network: '', subnet_mask: '', description: '' });
        setShowAdd(false);
        fetchSegments();
      } else {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          setError(data.error || 'Failed to add segment');
        } catch (e) {
          setError('Failed to add segment (Server error)');
        }
      }
    }
  };

  const handleEditClick = (segment: Segment, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSegment(segment);
    setNewSegment({
      name: segment.name,
      network: segment.network,
      subnet_mask: segment.subnet_mask,
      description: segment.description || ''
    });
    setShowAdd(true);
  };

  const handleCancelAdd = () => {
    setShowAdd(false);
    setEditingSegment(null);
    setNewSegment({ name: '', network: '', subnet_mask: '', description: '' });
    setError('');
  };

  const executeDeleteSegment = async () => {
    if (!segmentToDelete) return;
    await fetch(`/api/segments/${segmentToDelete.id}`, { method: 'DELETE' });
    setSegmentToDelete(null);
    fetchSegments();
  };

  if (selectedSegment) {
    return <IPsView segment={selectedSegment} onBack={() => setSelectedSegment(null)} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-medium text-gray-900">All Segments</h2>
        {user?.role === 'admin' && (
          <Button onClick={() => {
            setEditingSegment(null);
            setNewSegment({ name: '', network: '', subnet_mask: '', description: '' });
            setShowAdd(!showAdd);
          }}>
            <Plus className="h-4 w-4 mr-2" /> Add Segment
          </Button>
        )}
      </div>

      {showAdd && (
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <h3 className="text-md font-medium mb-4">{editingSegment ? 'Edit Segment' : 'New Segment'}</h3>
          {error && <div className="text-red-500 text-sm mb-4">{error}</div>}
          <form onSubmit={handleAddSegment} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Input placeholder="Name (e.g. Servers)" required value={newSegment.name} onChange={e => setNewSegment({...newSegment, name: e.target.value})} />
              <Input placeholder="Network (e.g. 192.168.1.0)" required value={newSegment.network} onChange={e => setNewSegment({...newSegment, network: e.target.value})} />
              <Input placeholder="Subnet Mask (e.g. 255.255.255.0)" required value={newSegment.subnet_mask} onChange={e => setNewSegment({...newSegment, subnet_mask: e.target.value})} />
              <Input placeholder="Description" value={newSegment.description} onChange={e => setNewSegment({...newSegment, description: e.target.value})} />
            </div>
            <div className="flex justify-end space-x-2">
              <Button type="button" variant="outline" onClick={handleCancelAdd}>Cancel</Button>
              <Button type="submit">{editingSegment ? 'Update Segment' : 'Save Segment'}</Button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {segments.map(segment => (
          <div key={segment.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow cursor-pointer" onClick={() => setSelectedSegment(segment)}>
            <div className="p-6">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{segment.name}</h3>
                  <p className="text-sm text-indigo-600 font-mono mt-1">{segment.network} / {segment.subnet_mask}</p>
                </div>
                {user?.role === 'admin' && (
                  <div className="flex items-center space-x-2">
                    <button 
                      onClick={(e) => handleEditClick(segment, e)}
                      className="text-gray-400 hover:text-indigo-500"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); setSegmentToDelete(segment); }}
                      className="text-gray-400 hover:text-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-4 line-clamp-2">{segment.description || 'No description'}</p>
            </div>
            <div className="bg-gray-50 px-6 py-3 border-t border-gray-100 text-sm text-gray-600 flex justify-between items-center">
              <span>Manage IPs</span>
              <Activity className="h-4 w-4 text-gray-400" />
            </div>
          </div>
        ))}
        {segments.length === 0 && !showAdd && (
          <div className="col-span-full text-center py-12 text-gray-500">
            No segments found. Create one to get started.
          </div>
        )}
      </div>

      {segmentToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-sm w-full mx-4">
            <h3 className="text-lg font-medium text-gray-900 mb-2">Delete Segment</h3>
            <p className="text-sm text-gray-500 mb-4">Are you sure you want to delete the segment "{segmentToDelete.name}"? This will also delete all IPs within it. This action cannot be undone.</p>
            <div className="flex justify-end space-x-3">
              <Button variant="outline" onClick={() => setSegmentToDelete(null)}>Cancel</Button>
              <button onClick={executeDeleteSegment} className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm font-medium">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// IPs View
function IPsView({ segment, onBack }: { segment: Segment, onBack: () => void }) {
  const { user } = useContext(AuthContext);
  const [ips, setIps] = useState<IP[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editingIp, setEditingIp] = useState<IP | null>(null);
  const [newIp, setNewIp] = useState({ ip_address: '', hostname: '', os: '', description: '' });
  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 100;

  useEffect(() => {
    fetchIps();
    const interval = setInterval(fetchIps, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [segment.id]);

  const fetchIps = () => {
    fetch(`/api/segments/${segment.id}/ips`)
      .then(async res => {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch (e) {
          console.error(`Invalid JSON from /api/segments/${segment.id}/ips:`, text.substring(0, 50));
          return [];
        }
      })
      .then(data => {
        if (Array.isArray(data)) {
          setIps(data);
        } else {
          console.error('Expected array of IPs, got:', data);
          setIps([]);
        }
      })
      .catch(err => {
        console.error('Error fetching IPs:', err);
        setIps([]);
      });
  };

  const handleAddIp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (editingIp) {
      const res = await fetch(`/api/ips/${editingIp.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newIp),
      });
      
      if (res.ok) {
        setNewIp({ ip_address: '', hostname: '', os: '', description: '' });
        setShowAdd(false);
        setEditingIp(null);
        fetchIps();
      } else {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          setError(data.error || 'Failed to update IP');
        } catch (e) {
          setError('Failed to update IP (Server error)');
        }
      }
    } else {
      const res = await fetch(`/api/segments/${segment.id}/ips`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newIp),
      });
      
      if (res.ok) {
        setNewIp({ ip_address: '', hostname: '', os: '', description: '' });
        setShowAdd(false);
        fetchIps();
      } else {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          setError(data.error || 'Failed to add IP');
        } catch (e) {
          setError('Failed to add IP (Server error)');
        }
      }
    }
  };

  const handleEditIpClick = (ip: IP) => {
    setEditingIp(ip);
    setNewIp({
      ip_address: ip.ip_address,
      hostname: ip.hostname || '',
      os: ip.os || '',
      description: ip.description || ''
    });
    setShowAdd(true);
  };

  const handleCancelAddIp = () => {
    setShowAdd(false);
    setEditingIp(null);
    setNewIp({ ip_address: '', hostname: '', os: '', description: '' });
    setError('');
  };

  const canEdit = user?.role === 'admin' || user?.role === 'editor';
  
  const totalPages = Math.ceil(ips.length / itemsPerPage);
  const displayedIps = ips.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  return (
    <div className="space-y-6">
      <div className="flex items-center text-sm text-gray-500 mb-4">
        <button onClick={onBack} className="hover:text-indigo-600 hover:underline">Segments</button>
        <span className="mx-2">/</span>
        <span className="text-gray-900 font-medium">{segment.name}</span>
      </div>

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{segment.name}</h2>
          <p className="text-sm text-gray-500 font-mono mt-1">{segment.network} / {segment.subnet_mask}</p>
        </div>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white p-6 rounded-lg shadow-lg max-w-2xl w-full">
            <h3 className="text-lg font-medium mb-4">{editingIp ? 'Edit IP Address' : 'New IP Address'}</h3>
            {error && <div className="text-red-500 text-sm mb-4">{error}</div>}
            <form onSubmit={handleAddIp} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">IP Address</label>
                  <Input placeholder="e.g. 192.168.1.10" required value={newIp.ip_address} onChange={e => setNewIp({...newIp, ip_address: e.target.value})} disabled={!!editingIp} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Hostname</label>
                  <Input placeholder="Hostname" value={newIp.hostname} onChange={e => setNewIp({...newIp, hostname: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">OS</label>
                  <Input placeholder="e.g. Windows, Linux" value={newIp.os} onChange={e => setNewIp({...newIp, os: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <Input placeholder="Description" value={newIp.description} onChange={e => setNewIp({...newIp, description: e.target.value})} />
                </div>
              </div>
              <div className="flex justify-end space-x-3 mt-6">
                <Button type="button" variant="outline" onClick={handleCancelAddIp}>Cancel</Button>
                <Button type="submit">{editingIp ? 'Update IP' : 'Save IP'}</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">IP Address</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Hostname</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">OS</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Seen</th>
              {canEdit && <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {displayedIps.map((ip) => (
              <tr key={ip.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    ip.status === 'online' ? 'bg-green-100 text-green-800' : 
                    ip.status === 'offline' ? 'bg-red-100 text-red-800' : 
                    'bg-gray-100 text-gray-800'
                  }`}>
                    <span className={`w-2 h-2 mr-1.5 rounded-full ${
                      ip.status === 'online' ? 'bg-green-500' : 
                      ip.status === 'offline' ? 'bg-red-500' : 
                      'bg-gray-500'
                    }`}></span>
                    {ip.status}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900">{ip.ip_address}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{ip.hostname || '-'}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{ip.os || '-'}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{ip.description || '-'}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {ip.last_seen ? new Date(ip.last_seen).toLocaleString() : 'Never'}
                </td>
                {canEdit && (
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="flex justify-end space-x-3">
                      <button onClick={() => handleEditIpClick(ip)} className="text-indigo-600 hover:text-indigo-900">
                        <Edit2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {ips.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 7 : 6} className="px-6 py-12 text-center text-sm text-gray-500">
                  No IPs found in this segment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        
        {totalPages > 1 && (
          <div className="bg-white px-4 py-3 border-t border-gray-200 flex items-center justify-between sm:px-6">
            <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-gray-700">
                  Showing <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="font-medium">{Math.min(currentPage * itemsPerPage, ips.length)}</span> of <span className="font-medium">{ips.length}</span> results
                </p>
              </div>
              <div>
                <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="relative inline-flex items-center px-4 py-2 border border-gray-300 bg-white text-sm font-medium text-gray-700">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Next
                  </button>
                </nav>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [currentView, setCurrentView] = useState('segments');

  return (
    <AuthProvider>
      <AuthContext.Consumer>
        {({ user }) => user ? (
          <Dashboard currentView={currentView} onNavigate={setCurrentView}>
            {currentView === 'segments' ? <SegmentsView /> : <SettingsView />}
          </Dashboard>
        ) : (
          <Login />
        )}
      </AuthContext.Consumer>
    </AuthProvider>
  );
}
