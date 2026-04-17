'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Label } from '@/components/ui/label';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { ValidationSummary } from '@/components/admin/wizard/ValidationSummary';
import { classroomWizardSteps, getScheduleErrors } from '@/lib/admin/classroom-wizard';
import { useAdminClassroomWizardStore } from '@/lib/store/admin-classroom-wizard';

export default function ClassroomWizardSchedulePage() {
  const router = useRouter();
  const { draft, setDraft, hasUnsavedChanges, markSaved, getStepState } = useAdminClassroomWizardStore();

  const errors = useMemo(() => getScheduleErrors(draft), [draft]);
  const stepState = useMemo(
    () => Object.fromEntries(classroomWizardSteps.map((s) => [s.id, s.id === 'schedule' ? (errors.length ? 'error' : 'active') : getStepState(s.id)])),
    [errors.length, getStepState],
  );

  return (
    <WizardShell
      title="Create Classroom - Schedule"
      entityLabel="Classroom setup"
      steps={classroomWizardSteps.map((s) => ({ ...s }))}
      currentStepId="schedule"
      stepState={stepState}
      canGoNext={errors.length === 0}
      isSaving={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/classrooms/new/access')}
      onNext={() => router.push('/admin/classrooms/new/review')}
    >
      <ValidationSummary errors={errors} />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="pacingMode" className="text-slate-200">Pacing mode</Label>
          <select
            id="pacingMode"
            value={draft.pacingMode}
            onChange={(e) => setDraft({ pacingMode: e.target.value as 'self_paced' | 'scheduled' })}
            className="h-9 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none"
          >
            <option value="self_paced">Self paced</option>
            <option value="scheduled">Scheduled</option>
          </select>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="startAt" className="text-slate-200">Start date</Label>
            <input
              id="startAt"
              type="datetime-local"
              value={draft.startAt}
              onChange={(e) => setDraft({ startAt: e.target.value })}
              className="h-9 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endAt" className="text-slate-200">End date</Label>
            <input
              id="endAt"
              type="datetime-local"
              value={draft.endAt}
              onChange={(e) => setDraft({ endAt: e.target.value })}
              className="h-9 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none"
            />
          </div>
        </div>
      </div>
    </WizardShell>
  );
}
