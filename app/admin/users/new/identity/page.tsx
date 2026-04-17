'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { ValidationSummary } from '@/components/admin/wizard/ValidationSummary';
import { useAdminUserWizardStore } from '@/lib/store/admin-user-wizard';
import { getIdentityErrors, userWizardSteps } from '@/lib/admin/user-wizard';

export default function UserWizardIdentityPage() {
  const router = useRouter();
  const { draft, setDraft, markSaved, hasUnsavedChanges, getStepState } = useAdminUserWizardStore();

  const errors = useMemo(() => getIdentityErrors(draft), [draft]);
  const stepState = useMemo(
    () => Object.fromEntries(userWizardSteps.map((s) => [s.id, s.id === 'identity' ? (errors.length ? 'error' : 'active') : getStepState(s.id)])),
    [errors.length, getStepState],
  );

  return (
    <WizardShell
      title="Create User - Identity"
      entityLabel="User setup"
      steps={userWizardSteps.map((s) => ({ ...s }))}
      currentStepId="identity"
      stepState={stepState}
      canGoNext={errors.length === 0}
      isSaving={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/users')}
      onNext={() => router.push('/admin/users/new/role')}
    >
      <ValidationSummary errors={errors} />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name" className="text-slate-200">Full name</Label>
          <Input
            id="name"
            value={draft.name}
            onChange={(e) => setDraft({ name: e.target.value })}
            placeholder="Enter full name"
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-slate-200">Email</Label>
          <Input
            id="email"
            value={draft.email}
            onChange={(e) => setDraft({ email: e.target.value })}
            placeholder="name@example.com"
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
      </div>
    </WizardShell>
  );
}
