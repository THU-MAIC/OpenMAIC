'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { ReviewDiffCard } from '@/components/admin/wizard/ReviewDiffCard';
import { AuditContextPanel } from '@/components/admin/common/AuditContextPanel';
import { ValidationSummary } from '@/components/admin/wizard/ValidationSummary';
import { useAdminUserWizardStore } from '@/lib/store/admin-user-wizard';
import { canSubmitUserWizard, getIdentityErrors, getRoleErrors, getSecurityErrors, userWizardSteps } from '@/lib/admin/user-wizard';

export default function UserWizardReviewPage() {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const { draft, reset, markSaved, hasUnsavedChanges, getStepState } = useAdminUserWizardStore();

  const errors = useMemo(
    () => [...getIdentityErrors(draft), ...getRoleErrors(draft), ...getSecurityErrors(draft)],
    [draft],
  );

  const stepState = useMemo(
    () => Object.fromEntries(userWizardSteps.map((s) => [s.id, s.id === 'review' ? (errors.length ? 'error' : 'active') : getStepState(s.id)])),
    [errors.length, getStepState],
  );

  async function submit() {
    if (!canSubmitUserWizard(draft)) {
      toast.error('Resolve validation errors before creating user.');
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          email: draft.email.trim(),
          studentId: draft.role === 'STUDENT' ? draft.studentId.trim() : '',
          password: draft.password,
          role: draft.role,
          isActive: draft.isActive,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unable to create user.' }));
        throw new Error(data.error ?? 'Unable to create user.');
      }

      toast.success('User created successfully.');
      reset();
      router.push('/admin/users');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create user.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <WizardShell
      title="Create User - Review"
      entityLabel="User setup"
      steps={userWizardSteps.map((s) => ({ ...s }))}
      currentStepId="review"
      stepState={stepState}
      canGoNext={canSubmitUserWizard(draft)}
      isSaving={isSaving}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/users/new/security')}
      onNext={() => void submit()}
      nextLabel="Create user"
    >
      <ValidationSummary errors={errors} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <ReviewDiffCard
          title="User summary"
          items={[
            { label: 'Name', value: draft.name || '—' },
            { label: 'Email', value: draft.email || '—' },
            { label: 'Role', value: draft.role },
            { label: 'Student ID', value: draft.role === 'STUDENT' ? draft.studentId || '—' : 'Not applicable' },
            { label: 'Status', value: draft.isActive ? 'Active' : 'Disabled' },
          ]}
        />
        <AuditContextPanel actions={['user.create']} />
      </div>
    </WizardShell>
  );
}
