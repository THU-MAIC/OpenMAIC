'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { ReviewDiffCard } from '@/components/admin/wizard/ReviewDiffCard';
import { AuditContextPanel } from '@/components/admin/common/AuditContextPanel';
import { ValidationSummary } from '@/components/admin/wizard/ValidationSummary';
import { classroomWizardSteps, canSubmitClassroomWizard, getBasicsErrors, getContentErrors, getScheduleErrors } from '@/lib/admin/classroom-wizard';
import { useAdminClassroomWizardStore } from '@/lib/store/admin-classroom-wizard';

export default function ClassroomWizardReviewPage() {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const { draft, reset, hasUnsavedChanges, markSaved, getStepState } = useAdminClassroomWizardStore();

  const errors = useMemo(
    () => [...getBasicsErrors(draft), ...getContentErrors(draft), ...getScheduleErrors(draft)],
    [draft],
  );

  const stepState = useMemo(
    () => Object.fromEntries(classroomWizardSteps.map((s) => [s.id, s.id === 'review' ? (errors.length ? 'error' : 'active') : getStepState(s.id)])),
    [errors.length, getStepState],
  );

  async function submit() {
    if (!canSubmitClassroomWizard(draft)) {
      toast.error('Resolve validation errors before creating classroom.');
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch('/api/admin/classrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classroomId: draft.classroomId.trim(),
          title: draft.title.trim(),
          description: draft.description.trim(),
          sourceType: draft.sourceType,
          templateId: draft.templateId.trim(),
          studentIds: draft.studentIds,
          startAt: draft.startAt || null,
          endAt: draft.endAt || null,
          pacingMode: draft.pacingMode,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unable to create classroom.' }));
        throw new Error(data.error ?? 'Unable to create classroom.');
      }

      toast.success('Classroom created successfully.');
      reset();
      router.push('/admin/classrooms');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create classroom.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <WizardShell
      title="Create Classroom - Review"
      entityLabel="Classroom setup"
      steps={classroomWizardSteps.map((s) => ({ ...s }))}
      currentStepId="review"
      stepState={stepState}
      canGoNext={canSubmitClassroomWizard(draft)}
      isSaving={isSaving}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/classrooms/new/schedule')}
      onNext={() => void submit()}
      nextLabel="Create classroom"
    >
      <ValidationSummary errors={errors} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <ReviewDiffCard
          title="Classroom summary"
          items={[
            { label: 'Classroom ID', value: draft.classroomId || '—' },
            { label: 'Title', value: draft.title || '—' },
            { label: 'Source', value: draft.sourceType },
            { label: 'Pacing', value: draft.pacingMode },
            { label: 'Start', value: draft.startAt || 'Not set' },
            { label: 'End', value: draft.endAt || 'Not set' },
          ]}
        />
        <AuditContextPanel actions={['classroom.create']} />
      </div>
    </WizardShell>
  );
}
