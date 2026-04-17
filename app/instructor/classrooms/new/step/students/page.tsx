'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus, X, Search, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useClassroomWizard, type PendingStudent } from '@/lib/contexts/classroom-wizard-context';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { useI18n } from '@/lib/hooks/use-i18n';

const STEPS = [
  { id: 'basics', title: 'Basics', href: '/instructor/classrooms/new/step/basics' },
  { id: 'content', title: 'Content', href: '/instructor/classrooms/new/step/content' },
  { id: 'students', title: 'Students', href: '/instructor/classrooms/new/step/students' },
  { id: 'schedule', title: 'Schedule', href: '/instructor/classrooms/new/step/schedule' },
  { id: 'review', title: 'Review & Create', href: '/instructor/classrooms/new/step/review' },
];

interface DbUser {
  id: string;
  name: string | null;
  email: string;
  studentId: string | null;
}

export default function StudentsPage() {
  const router = useRouter();
  const { pendingStudents, addStudent, removeStudent } = useClassroomWizard();

  const [form, setForm] = useState({ name: '', studentId: '', email: '' });
  const [dbQuery, setDbQuery] = useState('');
  const [dbResults, setDbResults] = useState<DbUser[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [selectedDbUser, setSelectedDbUser] = useState<DbUser | null>(null);

  const searchDb = useCallback(async (q: string) => {
    if (!q.trim()) { setDbResults([]); return; }
    setDbLoading(true);
    try {
      const params = new URLSearchParams({ q, role: 'STUDENT' });
      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json() as { users?: DbUser[] };
      setDbResults(data.users ?? []);
    } catch {
      // non-critical
    } finally {
      setDbLoading(false);
    }
  }, []);

  const handleSelectDbUser = (u: DbUser) => {
    setSelectedDbUser(u);
    setForm({ name: u.name ?? '', studentId: u.studentId ?? '', email: u.email });
    setDbResults([]);
    setDbQuery('');
  };

  const handleAdd = () => {
    const name = form.name.trim();
    if (!name) { toast.error(t('classroomWizard.students.nameRequired')); return; }
    if (!selectedDbUser && !form.email.trim()) {
      toast.error(t('classroomWizard.students.emailRequired'));
      return;
    }
    const student: PendingStudent = {
      name,
      studentId: form.studentId.trim() || undefined,
      email: form.email.trim() || undefined,
      dbUserId: selectedDbUser?.id,
    };
    addStudent(student);
    setForm({ name: '', studentId: '', email: '' });
    setSelectedDbUser(null);
  };

  return (
    <WizardShell
      title={t('classroomWizard.title')}
      entityLabel={t('classroomWizard.students.stepLabel')}
      steps={STEPS}
      currentStepId="students"
      stepState={{ basics: 'valid', content: 'valid', students: 'active', schedule: 'todo', review: 'todo' }}
      canGoNext={true}
      isSaving={false}
      hasUnsavedChanges={pendingStudents.length > 0}
      onBack={() => router.push('/instructor/classrooms/new/step/content')}
      backLabel={t('classroomWizard.students.back')}
      onNext={() => router.push('/instructor/classrooms/new/step/schedule')}
      nextLabel={t('classroomWizard.students.next')}
    >
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('classroomWizard.students.sectionTitle')}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {t('classroomWizard.students.sectionDesc')}
          </p>
        </div>

        {/* DB search */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-200">
            {t('classroomWizard.students.searchLabel')}
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={dbQuery}
              onChange={(e) => { setDbQuery(e.target.value); void searchDb(e.target.value); }}
              placeholder={t('classroomWizard.students.searchPlaceholder')}
              className="w-full rounded-lg border border-white/10 bg-white/5 pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          {dbLoading && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="w-3 h-3 animate-spin" /> {t('classroomWizard.students.searching')}
            </div>
          )}
          {dbResults.length > 0 && (
            <ul className="rounded-lg border border-white/10 bg-slate-800 divide-y divide-white/5 max-h-48 overflow-y-auto">
              {dbResults.slice(0, 10).map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectDbUser(u)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-white/8 transition-colors"
                  >
                    <span className="font-medium text-white">{u.name ?? '—'}</span>
                    <span className="ml-2 text-slate-400 text-xs">{u.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Manual add form */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {selectedDbUser ? `${t('classroomWizard.students.linkedTo')} ${selectedDbUser.email}` : t('classroomWizard.students.orAddManually')}
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-slate-400">{t('classroomWizard.students.nameField')} *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Full name"
                maxLength={200}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">{t('classroomWizard.students.studentIdField')}</label>
              <input
                type="text"
                value={form.studentId}
                onChange={(e) => setForm((f) => ({ ...f, studentId: e.target.value }))}
                placeholder="e.g. 2024001"
                maxLength={50}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">{t('classroomWizard.students.emailField')} {selectedDbUser ? '' : '*'}</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="student@example.com"
                maxLength={254}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleAdd}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
          >
            <UserPlus className="w-4 h-4" />
            {t('classroomWizard.students.addStudentBtn')}
          </button>
        </div>

        {/* Pending list */}
        {pendingStudents.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium text-slate-300">
              {t('classroomWizard.students.pendingCount', { count: String(pendingStudents.length) })}
            </p>
            <ul className="space-y-1.5">
              {pendingStudents.map((s, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                >
                  <div>
                    <span className="font-medium text-white">{s.name}</span>
                    {s.email && <span className="ml-2 text-slate-400 text-xs">{s.email}</span>}
                    {s.dbUserId && (
                      <span className="ml-2 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-400">
                        linked
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeStudent(i)}
                    className="text-slate-500 hover:text-red-400 transition-colors"
                    aria-label="Remove student"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </WizardShell>
  );
}
