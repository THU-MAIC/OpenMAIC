'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { useClassroomWizard } from '@/lib/contexts/classroom-wizard-context';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { useI18n } from '@/lib/hooks/use-i18n';

export default function ReviewPage() {
  const router = useRouter();
  const { title, description, language, pendingStudents, pacingMode, startAt, endAt, reset } = useClassroomWizard();
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);

  const STEPS = [
    { id: 'basics', title: t('classroomWizard.steps.basics'), href: '/instructor/classrooms/new/step/basics' },
    { id: 'content', title: t('classroomWizard.steps.content'), href: '/instructor/classrooms/new/step/content' },
    { id: 'students', title: t('classroomWizard.steps.students'), href: '/instructor/classrooms/new/step/students' },
    { id: 'schedule', title: t('classroomWizard.steps.schedule'), href: '/instructor/classrooms/new/step/schedule' },
    { id: 'review', title: t('classroomWizard.steps.review'), href: '/instructor/classrooms/new/step/review' },
  ];

  const handleCreate = async () => {
    if (!title.trim()) {
      toast.error(t('classroomWizard.review.titleRequired'));
      router.push('/instructor/classrooms/new/step/basics');
      return;
    }

    setSaving(true);
    try {
      // 1. Create classroom
      const classroomRes = await fetch('/api/classroom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage: {
            id: crypto.randomUUID(),
            name: title.trim(),
            description: description.trim() || undefined,
            language,
            pacingMode,
            startAt: startAt || undefined,
            endAt: endAt || undefined,
            elements: [],
            updatedAt: Date.now(),
          },
          scenes: [],
        }),
      });

      if (!classroomRes.ok) {
        const payload = await classroomRes.json().catch(() => ({})) as { error?: string };
        toast.error(payload.error ?? t('classroomWizard.review.createFailed'));
        return;
      }

      const { id: classroomId } = await classroomRes.json() as { id: string };

      // 2. Assign DB-linked students via the admin assign endpoint
      const dbLinkedStudents = pendingStudents.filter((s) => s.dbUserId);
      if (dbLinkedStudents.length > 0) {
        const assignRes = await fetch(`/api/admin/classrooms/${classroomId}/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds: dbLinkedStudents.map((s) => s.dbUserId) }),
        });

        if (!assignRes.ok) {
          const payload = (await assignRes.json().catch(() => ({}))) as { error?: string };
          toast.error(payload.error ?? t('classroomWizard.review.enrollFailed'));
        }
      }

      // 3. Auto-create + enroll manual students
      const manualStudents = pendingStudents.filter((s) => !s.dbUserId);
      let manualEnrollFailed = 0;

      for (const student of manualStudents) {
        // Students without email cannot be auto-created securely.
        if (!student.email?.trim()) {
          manualEnrollFailed += 1;
          continue;
        }

        const createRes = await fetch(`/api/admin/classrooms/${classroomId}/create-and-enroll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: student.name,
            email: student.email,
            studentId: student.studentId || '',
            notes: '',
          }),
        });

        if (!createRes.ok) {
          manualEnrollFailed += 1;
        }
      }

      if (manualEnrollFailed > 0) {
        toast.warning(
          t('classroomWizard.review.manualEnrollFailed', { count: String(manualEnrollFailed) }),
        );
      }

      toast.success(t('classroomWizard.review.created'));
      reset();
      const params = new URLSearchParams({
        wizardClassroomId: classroomId,
        wizardClassroomTitle: title.trim(),
        prefillRequirement: (description.trim() || title.trim()).trim(),
        wizardLanguage: language,
      });
      router.push(`/?${params.toString()}`);
    } catch (err) {
      toast.error(t('classroomWizard.review.unexpectedError'));
      console.error('[wizard/review] create error', err);
    } finally {
      setSaving(false);
    }
  };

  const langLabel =
    language === 'zh-CN'
      ? t('classroomWizard.languages.zhCN')
      : language === 'th-TH'
        ? t('classroomWizard.languages.thTH')
        : t('classroomWizard.languages.en');

  return (
    <WizardShell
      title={t('classroomWizard.title')}
      entityLabel={t('classroomWizard.review.stepLabel')}
      steps={STEPS}
      currentStepId="review"
      stepState={{ basics: 'valid', content: 'valid', students: 'valid', schedule: 'valid', review: 'active' }}
      canGoNext={!saving && title.trim().length > 0}
      isSaving={saving}
      hasUnsavedChanges={true}
      onBack={() => router.push('/instructor/classrooms/new/step/schedule')}
      backLabel={t('classroomWizard.review.back')}
      onNext={() => void handleCreate()}
      nextLabel={saving ? t('classroomWizard.review.creating') : t('classroomWizard.review.createBtn')}
    >
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('classroomWizard.review.sectionTitle')}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {t('classroomWizard.review.sectionDesc')}
          </p>
        </div>

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ReviewRow label={t('classroomWizard.review.rowTitle')} value={title} />
          <ReviewRow label={t('classroomWizard.review.rowLanguage')} value={langLabel} />
          <ReviewRow label={t('classroomWizard.review.rowDescription')} value={description || '—'} />
          <ReviewRow
            label={t('classroomWizard.review.rowStudents')}
            value={`${pendingStudents.length} (${pendingStudents.filter((s) => s.dbUserId).length} ${t('classroomWizard.review.linkedAccounts')})`}
          />
          <ReviewRow
            label={t('classroomWizard.review.rowPacing')}
            value={pacingMode === 'scheduled' ? t('classroomWizard.schedule.scheduled') : t('classroomWizard.schedule.selfPaced')}
          />
          {startAt && <ReviewRow label={t('classroomWizard.review.rowStartDate')} value={new Date(startAt).toLocaleString()} />}
          {endAt && <ReviewRow label={t('classroomWizard.review.rowEndDate')} value={new Date(endAt).toLocaleString()} />}
        </dl>

        {pendingStudents.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              {t('classroomWizard.review.studentList')}
            </p>
            <ul className="space-y-1">
              {pendingStudents.map((s, i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-slate-300">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  {s.name}
                  {s.email && <span className="text-slate-500 text-xs">&lt;{s.email}&gt;</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {saving && (
          <div className="flex items-center gap-2 text-sm text-indigo-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('classroomWizard.review.creating')}
          </div>
        )}
      </div>
    </WizardShell>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <dt className="text-xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-slate-200">{value}</dd>
    </div>
  );
}
