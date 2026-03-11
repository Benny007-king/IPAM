import React, { useState, useEffect } from 'react';
import { Button } from './components/ui/Button';
import { Input } from './components/ui/Input';
import { Trash2, Edit2, Plus } from 'lucide-react';

export function SettingsView() {
  const [users, setUsers] = useState<any[]>([]);
  const [ldapSettings, setLdapSettings] = useState({ dc_addresses: '', port: 389, service_account: '', password: '' });
  const [adGroups, setAdGroups] = useState<any[]>([]);
  
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'readonly' });
  const [newAdGroup, setNewAdGroup] = useState({ group_name: '', role: 'readonly' });
  
  const [editingUser, setEditingUser] = useState<any>(null);
  
  const [confirmDelete, setConfirmDelete] = useState<{type: 'user' | 'adGroup', id: number} | null>(null);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchUsers();
    fetchLdapSettings();
    fetchAdGroups();
  }, []);

  const fetchUsers = async () => {
    const res = await fetch('/api/users');
    if (res.ok) setUsers(await res.json());
  };

  const fetchLdapSettings = async () => {
    const res = await fetch('/api/ldap');
    if (res.ok) setLdapSettings(await res.json());
  };

  const fetchAdGroups = async () => {
    const res = await fetch('/api/ad-groups');
    if (res.ok) setAdGroups(await res.json());
  };

  const handleSaveLdap = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/ldap', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ldapSettings)
    });
    setAlertMsg('LDAP Settings saved');
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
    }
    setConfirmDelete(null);
  };

  const handleAddAdGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/ad-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newAdGroup)
    });
    setNewAdGroup({ group_name: '', role: 'readonly' });
    fetchAdGroups();
  };

  const handleDeleteAdGroup = async (id: number) => {
    setConfirmDelete({ type: 'adGroup', id });
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
        <form onSubmit={handleSaveLdap} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">DC Addresses (comma separated)</label>
              <Input value={ldapSettings.dc_addresses} onChange={e => setLdapSettings({...ldapSettings, dc_addresses: e.target.value})} placeholder="e.g. 192.168.1.10, 192.168.1.11" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
              <Input type="number" value={ldapSettings.port} onChange={e => setLdapSettings({...ldapSettings, port: parseInt(e.target.value)})} placeholder="389" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Service Account Username</label>
              <Input value={ldapSettings.service_account} onChange={e => setLdapSettings({...ldapSettings, service_account: e.target.value})} placeholder="e.g. DOMAIN\\admin" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Service Account Password</label>
              <Input type="password" value={ldapSettings.password} onChange={e => setLdapSettings({...ldapSettings, password: e.target.value})} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit">Save LDAP Settings</Button>
          </div>
        </form>
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
          <Button type="submit"><Plus className="h-4 w-4 mr-2" /> Add Group</Button>
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
                  <button onClick={() => handleDeleteAdGroup(group.id)} className="text-red-600 hover:text-red-900"><Trash2 className="h-4 w-4" /></button>
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
