'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { ValidationSummary } from '@/components/admin/wizard/ValidationSummary';
import { classroomWizardSteps, getContentErrors } from '@/lib/admin/classroom-wizard';
import { useAdminClassroomWizardStore } from '@/lib/store/admin-classroom-wizard';

export default function ClassroomWizardContentPage() {
  const router = useRouter();
  const { draft, setDraft, hasUnsavedChanges, markSaved, getStepState } = useAdminClassroomWizardStore();

  const errors = useMemo(() => getContentErrors(draft), [draft]);
  const stepState = useMemo(
    () => Object.fromEntries(classroomWizardSteps.map((s) => [s.id, s.id === 'content' ? (errors.length ? 'error' : 'active') : getStepState(s.id)])),
    [errors.length, getStepState],
  );

  return (
    <WizardShell
      title="Create Classroom - Content"
      entityLabel="Classroom setup"
      steps={classroomWizardSteps.map((s) => ({ ...s }))}
      currentStepId="content"
      stepState={stepState}
      canGoNext={errors.length === 0}
      isSaving={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/classrooms/new/basics')}
      onNext={() => router.push('/admin/classrooms/new/access')}
    >
      <ValidationSummary errors={errors} />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="sourceType" className="text-slate-200">Content source</Label>
          <select
            id="sourceType"
            value={draft.sourceType}
            onChange={(e) => setDraft({ sourceType: e.target.value as 'blank' | 'template' | 'import' })}
            className="h-9 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none"
          >
            <option value="blank">Blank classroom</option>
            <option value="template">Template</option>
            <option value="import">Import</option>
          </select>
        </div>
        {draft.sourceType === 'template' && (
          <div className="space-y-1.5">
            <Label htmlFor="templateId" className="text-slate-200">Template ID</Label>
            <Input
              id="templateId"
              value={draft.templateId}
              onChange={(e) => setDraft({ templateId: e.target.value })}
              placeholder="template-english-101"
              className="border-white/10 bg-black/20 text-white"
            />
          </div>
        )}
      </div>
    </WizardShell>
  );
}
