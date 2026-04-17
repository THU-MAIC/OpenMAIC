'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { ValidationSummary } from '@/components/admin/wizard/ValidationSummary';
import { classroomWizardSteps, getBasicsErrors } from '@/lib/admin/classroom-wizard';
import { useAdminClassroomWizardStore } from '@/lib/store/admin-classroom-wizard';

export default function ClassroomWizardBasicsPage() {
  const router = useRouter();
  const { draft, setDraft, hasUnsavedChanges, markSaved, getStepState } = useAdminClassroomWizardStore();

  const errors = useMemo(() => getBasicsErrors(draft), [draft]);
  const stepState = useMemo(
    () => Object.fromEntries(classroomWizardSteps.map((s) => [s.id, s.id === 'basics' ? (errors.length ? 'error' : 'active') : getStepState(s.id)])),
    [errors.length, getStepState],
  );

  return (
    <WizardShell
      title="Create Classroom - Basics"
      entityLabel="Classroom setup"
      steps={classroomWizardSteps.map((s) => ({ ...s }))}
      currentStepId="basics"
      stepState={stepState}
      canGoNext={errors.length === 0}
      isSaving={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/classrooms')}
      onNext={() => router.push('/admin/classrooms/new/content')}
    >
      <ValidationSummary errors={errors} />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="classroom-id" className="text-slate-200">Classroom ID</Label>
          <Input
            id="classroom-id"
            value={draft.classroomId}
            onChange={(e) => setDraft({ classroomId: e.target.value })}
            placeholder="ENG101-2026-S1"
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="title" className="text-slate-200">Title</Label>
          <Input
            id="title"
            value={draft.title}
            onChange={(e) => setDraft({ title: e.target.value })}
            placeholder="English 101 Spring 2026"
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="description" className="text-slate-200">Description</Label>
          <textarea
            id="description"
            value={draft.description}
            onChange={(e) => setDraft({ description: e.target.value })}
            placeholder="Class description"
            className="min-h-24 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none"
          />
        </div>
      </div>
    </WizardShell>
  );
}
