'use client';

import { useState, useEffect, useCallback } from 'react';
import { UserPlus, Trash2, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AssignedUser {
  id: string;
  user: { id: string; name: string | null; email: string; role: string };
  assignedAt: string;
}

interface AvailableUser {
  id: string;
  name: string | null;
  email: string;
}

interface ClassroomAssignPanelProps {
  classroomId: string;
}

export function ClassroomAssignPanel({ classroomId }: ClassroomAssignPanelProps) {
  const [assigned, setAssigned] = useState<AssignedUser[]>([]);
  const [available, setAvailable] = useState<AvailableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const fetchAssigned = useCallback(async () => {
    const res = await fetch(`/api/admin/classrooms/${classroomId}/assign`);
    const data = await res.json();
    setAssigned(data.assignments ?? []);
  }, [classroomId]);

  const fetchAvailable = useCallback(async () => {
    const params = new URLSearchParams({ role: 'STUDENT' });
    if (search) params.set('q', search);
    const res = await fetch(`/api/admin/users?${params}`);
    const data = await res.json();
    setAvailable(data.users ?? []);
  }, [search]);

  useEffect(() => {
    Promise.all([fetchAssigned(), fetchAvailable()]).finally(() => setLoading(false));
  }, [fetchAssigned, fetchAvailable]);

  const assignedIds = new Set(assigned.map((a) => a.user.id));
  const unassigned = available.filter((u) => !assignedIds.has(u.id));

  async function assignSelected() {
    if (!selectedIds.size) return;
    setAdding(true);
    await fetch(`/api/admin/classrooms/${classroomId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [...selectedIds] }),
    });
    setSelectedIds(new Set());
    await fetchAssigned();
    setAdding(false);
  }

  async function removeStudent(userId: string) {
    await fetch(`/api/admin/classrooms/${classroomId}/assign?userId=${userId}`, { method: 'DELETE' });
    await fetchAssigned();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Assigned students */}
      <div>
        <h3 className="text-white font-medium mb-3 text-sm">Assigned Students ({assigned.length})</h3>
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          {assigned.length === 0 ? (
            <p className="text-slate-500 text-sm p-4">No students assigned yet.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {assigned.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-white text-sm font-medium">{a.user.name ?? '—'}</p>
                    <p className="text-slate-500 text-xs">{a.user.email}</p>
                  </div>
                  <button
                    onClick={() => removeStudent(a.user.id)}
                    className="p-1.5 rounded hover:bg-red-500/10 text-slate-400 hover:text-red-400 transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Add students */}
      <div>
        <h3 className="text-white font-medium mb-3 text-sm">Add Students</h3>
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search students…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden mb-3">
          {unassigned.length === 0 ? (
            <p className="text-slate-500 text-sm p-4">No students available to add.</p>
          ) : (
            <ul className="divide-y divide-white/5 max-h-56 overflow-y-auto">
              {unassigned.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(u.id)}
                    onChange={(e) => {
                      const next = new Set(selectedIds);
                      e.target.checked ? next.add(u.id) : next.delete(u.id);
                      setSelectedIds(next);
                    }}
                    className="w-4 h-4 accent-purple-500"
                  />
                  <div>
                    <p className="text-white text-sm">{u.name ?? '—'}</p>
                    <p className="text-slate-500 text-xs">{u.email}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button
          onClick={assignSelected}
          disabled={adding || !selectedIds.size}
          className="w-full bg-purple-600 hover:bg-purple-700 text-white gap-2"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
          Assign selected ({selectedIds.size})
        </Button>
      </div>
    </div>
  );
}
