import React, { useState, useEffect } from 'react';
import { Button } from './components/ui/Button';
import { Input } from './components/ui/Input';
import { Trash2, Edit2, Plus, CheckCircle, XCircle } from 'lucide-react';

export function SettingsView() {
  const [users, setUsers] = useState<any[]>([]);
  const [ldapServers, setLdapServers] = useState<any[]>([]);
  const [adGroups, setAdGroups] = useState<any[]>([]);
  
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'readonly' });
  const [newAdGroup, setNewAdGroup] = useState({ group_name: '', role: 'readonly' });
  const [newLdapServer, setNewLdapServer] = useState({ server_name: '', dc_addresses: '', port: 389, service_account: '', password: '' });
  
  const [editingUser, setEditingUser] = useState<any>(null);
  const [editingAdGroup, setEditingAdGroup] = useState<any>(null);
  const [editingLdapServer, setEditingLdapServer] = useState<any>(null);
  
  const [confirmDelete, setConfirmDelete] = useState<{type: 'user' | 'adGroup' | 'ldapServer', id: number} | null>(null);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{success: boolean, message: string} | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    fetchUsers();
    fetchLdapServers();
    fetchAdGroups();
  }, []);

  const fetchUsers = async () => {
    const res = await fetch('/api/users');
    if (res.ok) setUsers(await res.json());
  };

  const fetchLdapServers = async () => {
    const res = await fetch('/api/ldap');
    if (res.ok) setLdapServers(await res.json());
  };

  const fetchAdGroups = async () => {
    const res = await fetch('/api/ad-groups');
    if (res.ok) setAdGroups(await res.json());
  };

  const handleSaveLdap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingLdapServer) {
      await fetch(`/api/ldap/${editingLdapServer.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLdapServer)
      });
      setEditingLdapServer(null);
    } else {
      await fetch('/api/ldap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLdapServer)
      });
    }
    setNewLdapServer({ server_name: '', dc_addresses: '', port: 389, service_account: '', password: '' });
    fetchLdapServers();
    setTestResult(null);
  };

  const handleTestLdapConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ldap/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLdapServer)
      });
      const data = await res.json();
      if (res.ok) {
        setTestResult({ success: true, message: data.message });
      } else {
        setTestResult({ success: false, message: data.error });
      }
    } catch (err: any) {
      setTestResult({ success: false, message: 'Network error occurred' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingUser) {
      await fetch(`/api/users/${editingUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser)
      });
      setEditingUser(null);
    } else {
      await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser)
      });
    }
    setNewUser({ username: '', password: '', role: 'readonly' });
    fetchUsers();
  };

  const handleDeleteUser = async (id: number) => {
    setConfirmDelete({ type: 'user', id });
  };

  const confirmDeleteAction = async () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === 'user') {
      await fetch(`/api/users/${confirmDelete.id}`, { method: 'DELETE' });
      fetchUsers();
    } else if (confirmDelete.type === 'adGroup') {
      await fetch(`/api/ad-groups/${confirmDelete.id}`, { method: 'DELETE' });
      fetchAdGroups();
    } else if (confirmDelete.type === 'ldapServer') {
      await fetch(`/api/ldap/${confirmDelete.id}`, { method: 'DELETE' });
      fetchLdapServers();
    }
    setConfirmDelete(null);
  };

  const handleAddAdGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingAdGroup) {
      await fetch(`/api/ad-groups/${editingAdGroup.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAdGroup)
      });
      setEditingAdGroup(null);
    } else {
      await fetch('/api/ad-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAdGroup)
      });
    }
    setNewAdGroup({ group_name: '', role: 'readonly' });
    fetchAdGroups();
  };

  const handleDeleteAdGroup = async (id: number) => {
    setConfirmDelete({ type: 'adGroup', id });
  };

  const handleDeleteLdapServer = async (id: number) => {
    setConfirmDelete({ type: 'ldapServer', id });
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto relative">
      {alertMsg && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-lg max-w-sm w-full">
            <h3 className="text-lg font-medium mb-4">{alertMsg}</h3>
            <div className="flex justify-end">
              <Button onClick={() => setAlertMsg(null)}>OK</Button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-lg max-w-sm w-full">
            <h3 className="text-lg font-medium mb-4">Are you sure you want to delete this?</h3>
            <div className="flex justify-end space-x-3">
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={confirmDeleteAction}>Delete</Button>
            </div>
          </div>
        </div>
      )}

      {/* LDAP Settings */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h2 className="text-xl font-semibold mb-4">LDAP Configuration</h2>
        <form onSubmit={handleSaveLdap} className="space-y-4 mb-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Server Name</label>
              <Input value={newLdapServer.server_name} onChange={e => setNewLdapServer({...newLdapServer, server_name: e.target.value})} placeholder="e.g. Primary LDAP" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">DC Addresses (comma separated)</label>
              <Input value={newLdapServer.dc_addresses} onChange={e => setNewLdapServer({...newLdapServer, dc_addresses: e.target.value})} placeholder="e.g. 192.168.1.10, 192.168.1.11" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
              <Input type="number" value={newLdapServer.port} onChange={e => setNewLdapServer({...newLdapServer, port: parseInt(e.target.value)})} placeholder="389" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Service Account Username</label>
              <Input value={newLdapServer.service_account} onChange={e => setNewLdapServer({...newLdapServer, service_account: e.target.value})} placeholder="e.g. DOMAIN\admin" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Service Account Password</label>
              <Input type="password" value={newLdapServer.password} onChange={e => setNewLdapServer({...newLdapServer, password: e.target.value})} required={!editingLdapServer} placeholder={editingLdapServer ? "Leave blank to keep unchanged" : ""} />
            </div>
          </div>
          
          {testResult && (
            <div className={`p-3 rounded-md flex items-center text-sm ${testResult.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
              {testResult.success ? <CheckCircle className="w-4 h-4 mr-2" /> : <XCircle className="w-4 h-4 mr-2" />}
              {testResult.message}
            </div>
          )}

          <div className="flex justify-end space-x-3">
            <Button type="button" variant="outline" onClick={handleTestLdapConnection} disabled={isTesting || !newLdapServer.dc_addresses || !newLdapServer.service_account}>
              {isTesting ? 'Testing...' : 'Test Connection'}
            </Button>
            {editingLdapServer && (
              <Button type="button" variant="outline" onClick={() => { setEditingLdapServer(null); setNewLdapServer({ server_name: '', dc_addresses: '', port: 389, service_account: '', password: '' }); setTestResult(null); }}>
                Cancel
              </Button>
            )}
            <Button type="submit">{editingLdapServer ? 'Update Server' : 'Add Server'}</Button>
          </div>
        </form>

        {ldapServers.length > 0 && (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Server Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">DC Addresses</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Port</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {ldapServers.map(server => (
                <tr key={server.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{server.server_name}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{server.dc_addresses}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{server.port}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="flex justify-end space-x-3">
                      <button onClick={() => { setEditingLdapServer(server); setNewLdapServer({ server_name: server.server_name, dc_addresses: server.dc_addresses, port: server.port, service_account: server.service_account, password: '' }); setTestResult(null); }} className="text-indigo-600 hover:text-indigo-900"><Edit2 className="h-4 w-4" /></button>
                      <button onClick={() => handleDeleteLdapServer(server.id)} className="text-red-600 hover:text-red-900"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* AD Groups */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h2 className="text-xl font-semibold mb-4">AD Groups Permissions</h2>
        <form onSubmit={handleAddAdGroup} className="flex gap-4 mb-6">
          <Input className="flex-1" placeholder="AD Group Name" value={newAdGroup.group_name} onChange={e => setNewAdGroup({...newAdGroup, group_name: e.target.value})} required />
          <select className="border border-gray-300 rounded-md px-3 py-2" value={newAdGroup.role} onChange={e => setNewAdGroup({...newAdGroup, role: e.target.value})}>
            <option value="readonly">Read Only</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <Button type="submit">{editingAdGroup ? 'Update Group' : <><Plus className="h-4 w-4 mr-2" /> Add Group</>}</Button>
          {editingAdGroup && <Button type="button" variant="outline" onClick={() => { setEditingAdGroup(null); setNewAdGroup({ group_name: '', role: 'readonly' }); }}>Cancel</Button>}
        </form>
        
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Group Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {adGroups.map(group => (
              <tr key={group.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{group.group_name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 capitalize">{group.role}</td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex justify-end space-x-3">
                    <button onClick={() => { setEditingAdGroup(group); setNewAdGroup({ group_name: group.group_name, role: group.role }); }} className="text-indigo-600 hover:text-indigo-900"><Edit2 className="h-4 w-4" /></button>
                    <button onClick={() => handleDeleteAdGroup(group.id)} className="text-red-600 hover:text-red-900"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Local Users */}
      <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
        <h2 className="text-xl font-semibold mb-4">Local Users</h2>
        <form onSubmit={handleAddUser} className="flex gap-4 mb-6">
          <Input className="flex-1" placeholder="Username" value={newUser.username} onChange={e => setNewUser({...newUser, username: e.target.value})} required />
          <Input className="flex-1" type="password" placeholder={editingUser ? "New Password (leave blank to keep)" : "Password"} value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} required={!editingUser} />
          <select className="border border-gray-300 rounded-md px-3 py-2" value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})}>
            <option value="readonly">Read Only</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <Button type="submit">{editingUser ? 'Update User' : <><Plus className="h-4 w-4 mr-2" /> Add User</>}</Button>
          {editingUser && <Button type="button" variant="outline" onClick={() => { setEditingUser(null); setNewUser({ username: '', password: '', role: 'readonly' }); }}>Cancel</Button>}
        </form>
        
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Username</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {users.map(u => (
              <tr key={u.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{u.username}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 capitalize">{u.role}</td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex justify-end space-x-3">
                    <button onClick={() => { setEditingUser(u); setNewUser({ username: u.username, password: '', role: u.role }); }} className="text-indigo-600 hover:text-indigo-900"><Edit2 className="h-4 w-4" /></button>
                    {u.username !== 'admin' && (
                      <button onClick={() => handleDeleteUser(u.id)} className="text-red-600 hover:text-red-900"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

