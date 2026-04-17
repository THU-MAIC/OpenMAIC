'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Search,
  UserPlus,
  Trash2,
  Loader2,
  X,
  ChevronRight,
  Users,
  BookOpen,
} from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { useI18n } from '@/lib/hooks/use-i18n';

interface AssignedStudent {
  id: string;
  assignedAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    role: string;
  };
}

interface AvailableUser {
  id: string;
  name: string | null;
  email: string;
}

interface QuizSummary {
  count: number;
  totalScore: number;
  totalMax: number;
}

export default function InstructorStudentsPage() {
  const params = useParams<{ id: string }>();
  const classroomId = params.id;
  const { t } = useI18n();

  const [students, setStudents] = useState<AssignedStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAddPanel, setShowAddPanel] = useState(false);

  // Quiz summaries keyed by studentDbUserId
  const [quizSummaries, setQuizSummaries] = useState<Record<string, QuizSummary>>({});

  // DB user search within add panel
  const [dbQuery, setDbQuery] = useState('');
  const [dbResults, setDbResults] = useState<AvailableUser[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);

  // Removal state
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const fetchStudents = useCallback(async () => {
    setLoading(true);
    try {
      const [rosterRes, gradesRes] = await Promise.all([
        fetch(`/api/admin/classrooms/${classroomId}/assign`),
        fetch(`/api/instructor/classrooms/${classroomId}/grades`),
      ]);
      if (!rosterRes.ok) throw new Error('Failed to fetch students');
      const data = await rosterRes.json() as { assignments: AssignedStudent[] };
      setStudents(data.assignments ?? []);

      if (gradesRes.ok) {
        const gradesData = await gradesRes.json() as {
          results: Array<{ studentDbUserId: string | null; score: number; maxScore: number }>;
        };
        const summaries: Record<string, QuizSummary> = {};
        for (const r of gradesData.results ?? []) {
          if (!r.studentDbUserId) continue;
          const s = summaries[r.studentDbUserId] ?? { count: 0, totalScore: 0, totalMax: 0 };
          s.count += 1;
          s.totalScore += r.score;
          s.totalMax += r.maxScore;
          summaries[r.studentDbUserId] = s;
        }
        setQuizSummaries(summaries);
      }
    } catch {
      toast.error(t('instructorClassroomStudents.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [classroomId]);

  useEffect(() => { void fetchStudents(); }, [fetchStudents]);

  // Filter out non-student owner rows — owner has same userId/assignedBy
  const assignedIds = new Set(students.map((s) => s.user.id));

  const filtered = students.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.user.name?.toLowerCase().includes(q) ||
      s.user.email.toLowerCase().includes(q)
    );
  });

  // DB user search
  const searchDb = useCallback(async (q: string) => {
    if (!q.trim()) { setDbResults([]); return; }
    setDbLoading(true);
    try {
      const params = new URLSearchParams({ q, role: 'STUDENT' });
      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json() as { users?: AvailableUser[] };
      // Exclude already-assigned users
      setDbResults((data.users ?? []).filter((u) => !assignedIds.has(u.id)));
    } catch {
      // non-critical
    } finally {
      setDbLoading(false);
    }
  }, [assignedIds]);

  const handleAssign = async () => {
    if (!selectedIds.size) return;
    setAssigning(true);
    try {
      const res = await fetch(`/api/admin/classrooms/${classroomId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [...selectedIds] }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({})) as { error?: string };
        toast.error(payload.error ?? t('instructorClassroomStudents.assignFailed'));
        return;
      }
      toast.success(t('instructorClassroomStudents.assigned', { count: String(selectedIds.size) }));
      setSelectedIds(new Set());
      setShowAddPanel(false);
      setDbQuery('');
      setDbResults([]);
      await fetchStudents();
    } finally {
      setAssigning(false);
    }
  };

  const handleRemove = async (userId: string) => {
    setRemoving(true);
    try {
      const res = await fetch(
        `/api/admin/classrooms/${classroomId}/assign?userId=${encodeURIComponent(userId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        toast.error(t('instructorClassroomStudents.removeFailed'));
        return;
      }
      toast.success(t('instructorClassroomStudents.removed'));
      setConfirmRemoveId(null);
      await fetchStudents();
    } finally {
      setRemoving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="flex gap-6">
      {/* Main content */}
      <div className="flex-1 space-y-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('instructorClassroomStudents.searchPlaceholder')}
              className="w-full rounded-lg border border-white/10 bg-white/5 pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowAddPanel(true)}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors flex-shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            {t('instructorClassroomStudents.addStudent')}
          </button>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title={t('instructorClassroomStudents.emptyTitle')}
            description={t('instructorClassroomStudents.emptyDesc')}
            icon={<Users className="w-5 h-5" />}
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">{t('instructorClassroomStudents.columns.name')}</th>
                  <th className="px-4 py-3">{t('instructorClassroomStudents.columns.email')}</th>
                  <th className="px-4 py-3">{t('instructorClassroomStudents.columns.enrolled')}</th>
                  <th className="px-4 py-3">{t('instructorClassroomStudents.columns.quizzes')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtered.map((s) => {
                  const quiz = quizSummaries[s.user.id];
                  return (
                  <tr key={s.id} className="hover:bg-white/4">
                    <td className="px-4 py-3 font-medium text-white">
                      {s.user.name ?? <span className="text-slate-500">—</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{s.user.email}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {new Date(s.assignedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {quiz ? (
                        <Link
                          href={`/instructor/classrooms/${classroomId}/students/${s.user.id}`}
                          className="flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                          <BookOpen className="w-3 h-3 flex-shrink-0" />
                          {quiz.count} quiz{quiz.count !== 1 ? 'zes' : ''}&nbsp;·&nbsp;
                          {quiz.totalMax > 0
                            ? `${Math.round((quiz.totalScore / quiz.totalMax) * 100)}%`
                            : '—'}
                        </Link>
                      ) : (
                        <span className="text-slate-600">{t('instructorClassroomStudents.noResults')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/instructor/classrooms/${classroomId}/students/${s.user.id}`}
                          className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
                        >
                          {t('instructorClassroomStudents.view')} <ChevronRight className="w-3 h-3" />
                        </Link>

                        {confirmRemoveId === s.user.id ? (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-red-400">{t('instructorClassroomStudents.confirmRemove')}</span>
                            <button
                              type="button"
                              disabled={removing}
                              onClick={() => void handleRemove(s.user.id)}
                              className="rounded bg-red-600/20 px-2 py-1 text-xs text-red-400 hover:bg-red-600/40 transition-colors"
                            >
                              {removing ? <Loader2 className="w-3 h-3 animate-spin" /> : t('instructorClassroomStudents.confirmYes')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRemoveId(null)}
                              className="rounded border border-white/10 px-2 py-1 text-xs text-slate-400 hover:text-white transition-colors"
                            >
                              {t('instructorClassroomStudents.confirmNo')}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRemoveId(s.user.id)}
                            className="rounded border border-white/10 p-1 text-slate-500 hover:text-red-400 hover:border-red-400/30 transition-colors"
                            aria-label={t('instructorClassroomStudents.removeAriaLabel')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Student Side Panel */}
      {showAddPanel && (
        <aside className="w-80 flex-shrink-0 rounded-xl border border-white/10 bg-white/5 p-5 space-y-4 self-start">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-white">{t('instructorClassroomStudents.addPanelTitle')}</h3>
            <button
              type="button"
              onClick={() => { setShowAddPanel(false); setDbQuery(''); setDbResults([]); setSelectedIds(new Set()); }}
              className="text-slate-400 hover:text-white"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs text-slate-400">
            {t('instructorClassroomStudents.addPanelHint')}
          </p>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={dbQuery}
              onChange={(e) => { setDbQuery(e.target.value); void searchDb(e.target.value); }}
              placeholder={t('instructorClassroomStudents.addPanelSearchPlaceholder')}
              className="w-full rounded-lg border border-white/10 bg-white/5 pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {dbLoading && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="w-3 h-3 animate-spin" /> {t('instructorClassroomStudents.searching')}
            </div>
          )}

          {dbResults.length > 0 && (
            <ul className="divide-y divide-white/5 max-h-56 overflow-y-auto">
              {dbResults.slice(0, 15).map((u) => (
                <li key={u.id} className="py-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(u.id)}
                      onChange={(e) => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(u.id);
                          else next.delete(u.id);
                          return next;
                        });
                      }}
                      className="rounded border-white/20 bg-white/10 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <p className="text-sm text-white">{u.name ?? '—'}</p>
                      <p className="text-xs text-slate-400">{u.email}</p>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {selectedIds.size > 0 && (
            <button
              type="button"
              disabled={assigning}
              onClick={() => void handleAssign()}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-60"
            >
              {assigning ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {t('instructorClassroomStudents.enrollCount', { count: String(selectedIds.size) })}
            </button>
          )}
        </aside>
      )}
    </div>
  );
}
