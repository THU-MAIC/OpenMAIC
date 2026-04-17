'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { ValidationSummary } from '@/components/admin/wizard/ValidationSummary';
import { useAdminUserWizardStore } from '@/lib/store/admin-user-wizard';
import { getSecurityErrors, userWizardSteps } from '@/lib/admin/user-wizard';

export default function UserWizardSecurityPage() {
  const router = useRouter();
  const { draft, setDraft, markSaved, hasUnsavedChanges, getStepState } = useAdminUserWizardStore();

  const errors = useMemo(() => getSecurityErrors(draft), [draft]);
  const stepState = useMemo(
    () => Object.fromEntries(userWizardSteps.map((s) => [s.id, s.id === 'security' ? (errors.length ? 'error' : 'active') : getStepState(s.id)])),
    [errors.length, getStepState],
  );

  return (
    <WizardShell
      title="Create User - Security"
      entityLabel="User setup"
      steps={userWizardSteps.map((s) => ({ ...s }))}
      currentStepId="security"
      stepState={stepState}
      canGoNext={errors.length === 0}
      isSaving={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/users/new/access')}
      onNext={() => router.push('/admin/users/new/review')}
    >
      <ValidationSummary errors={errors} />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-slate-200">Password</Label>
          <Input
            id="password"
            type="password"
            value={draft.password}
            onChange={(e) => setDraft({ password: e.target.value })}
            placeholder="At least 10 chars with upper/lower/number/symbol"
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(e) => setDraft({ isActive: e.target.checked })}
            className="h-4 w-4 accent-primary"
          />
          Account active
        </label>
      </div>
    </WizardShell>
  );
}
