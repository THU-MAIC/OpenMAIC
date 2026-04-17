'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { classroomWizardSteps } from '@/lib/admin/classroom-wizard';
import { useAdminClassroomWizardStore } from '@/lib/store/admin-classroom-wizard';

export default function ClassroomWizardAccessPage() {
  const router = useRouter();
  const { hasUnsavedChanges, markSaved, getStepState } = useAdminClassroomWizardStore();

  const stepState = useMemo(
    () => Object.fromEntries(classroomWizardSteps.map((s) => [s.id, s.id === 'access' ? 'active' : getStepState(s.id)])),
    [getStepState],
  );

  return (
    <WizardShell
      title="Create Classroom - Access"
      entityLabel="Classroom setup"
      steps={classroomWizardSteps.map((s) => ({ ...s }))}
      currentStepId="access"
      stepState={stepState}
      canGoNext={true}
      isSaving={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/classrooms/new/content')}
      onNext={() => router.push('/admin/classrooms/new/schedule')}
    >
      <EmptyState
        title="Student assignment is optional in Phase 1"
        description="Create classroom first, then assign students from classroom detail page."
      />
    </WizardShell>
  );
}
