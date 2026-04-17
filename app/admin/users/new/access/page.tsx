'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { useAdminUserWizardStore } from '@/lib/store/admin-user-wizard';
import { userWizardSteps } from '@/lib/admin/user-wizard';

export default function UserWizardAccessPage() {
  const router = useRouter();
  const { markSaved, hasUnsavedChanges, getStepState } = useAdminUserWizardStore();

  const stepState = useMemo(
    () => Object.fromEntries(userWizardSteps.map((s) => [s.id, s.id === 'access' ? 'active' : getStepState(s.id)])),
    [getStepState],
  );

  return (
    <WizardShell
      title="Create User - Access"
      entityLabel="User setup"
      steps={userWizardSteps.map((s) => ({ ...s }))}
      currentStepId="access"
      stepState={stepState}
      canGoNext={true}
      isSaving={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/users/new/role')}
      onNext={() => router.push('/admin/users/new/security')}
    >
      <EmptyState
        title="Classroom assignment is optional in Phase 1"
        description="User is created first, then classroom assignments can be managed from the user detail workspace."
      />
    </WizardShell>
  );
}
