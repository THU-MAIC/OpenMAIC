'use client';

import { useRouter } from 'next/navigation';
import { useClassroomWizard } from '@/lib/contexts/classroom-wizard-context';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { useI18n } from '@/lib/hooks/use-i18n';

export default function SchedulePage() {
  const router = useRouter();
  const { pacingMode, startAt, endAt, setPacingMode, setStartAt, setEndAt } = useClassroomWizard();
  const { t } = useI18n();

  const STEPS = [
    { id: 'basics', title: t('classroomWizard.steps.basics'), href: '/instructor/classrooms/new/step/basics' },
    { id: 'content', title: t('classroomWizard.steps.content'), href: '/instructor/classrooms/new/step/content' },
    { id: 'students', title: t('classroomWizard.steps.students'), href: '/instructor/classrooms/new/step/students' },
    { id: 'schedule', title: t('classroomWizard.steps.schedule'), href: '/instructor/classrooms/new/step/schedule' },
    { id: 'review', title: t('classroomWizard.steps.review'), href: '/instructor/classrooms/new/step/review' },
  ];

  return (
    <WizardShell
      title={t('classroomWizard.title')}
      entityLabel={t('classroomWizard.schedule.stepLabel')}
      steps={STEPS}
      currentStepId="schedule"
      stepState={{
        basics: 'valid',
        content: 'valid',
        students: 'valid',
        schedule: 'active',
        review: 'todo',
      }}
      canGoNext={true}
      isSaving={false}
      hasUnsavedChanges={false}
      onBack={() => router.push('/instructor/classrooms/new/step/students')}
      backLabel={t('classroomWizard.schedule.back')}
      onNext={() => router.push('/instructor/classrooms/new/step/review')}
      nextLabel={t('classroomWizard.schedule.next')}
    >
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('classroomWizard.schedule.sectionTitle')}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {t('classroomWizard.schedule.sectionDesc')}
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="pacingMode" className="mb-1.5 block text-sm font-medium text-slate-200">
              {t('classroomWizard.schedule.pacingLabel')}
            </label>
            <select
              id="pacingMode"
              value={pacingMode}
              onChange={(e) => setPacingMode(e.target.value as 'self_paced' | 'scheduled')}
              className="rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="self_paced">{t('classroomWizard.schedule.selfPaced')}</option>
              <option value="scheduled">{t('classroomWizard.schedule.scheduled')}</option>
            </select>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="startAt" className="mb-1.5 block text-sm font-medium text-slate-200">
                {t('classroomWizard.schedule.startDateLabel')}
              </label>
              <input
                id="startAt"
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 [color-scheme:dark]"
              />
            </div>
            <div>
              <label htmlFor="endAt" className="mb-1.5 block text-sm font-medium text-slate-200">
                {t('classroomWizard.schedule.endDateLabel')}
              </label>
              <input
                id="endAt"
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 [color-scheme:dark]"
              />
            </div>
          </div>
        </div>
      </div>
    </WizardShell>
  );
}
