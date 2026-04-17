'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { WizardShell } from '@/components/admin/wizard/WizardShell';
import { ValidationSummary } from '@/components/admin/wizard/ValidationSummary';
import { useAdminUserWizardStore } from '@/lib/store/admin-user-wizard';
import { getRoleErrors, userWizardSteps } from '@/lib/admin/user-wizard';

export default function UserWizardRolePage() {
  const router = useRouter();
  const { draft, setDraft, markSaved, hasUnsavedChanges, getStepState } = useAdminUserWizardStore();

  const errors = useMemo(() => getRoleErrors(draft), [draft]);
  const stepState = useMemo(
    () => Object.fromEntries(userWizardSteps.map((s) => [s.id, s.id === 'role' ? (errors.length ? 'error' : 'active') : getStepState(s.id)])),
    [errors.length, getStepState],
  );

  return (
    <WizardShell
      title="Create User - Role"
      entityLabel="User setup"
      steps={userWizardSteps.map((s) => ({ ...s }))}
      currentStepId="role"
      stepState={stepState}
      canGoNext={errors.length === 0}
      isSaving={false}
      hasUnsavedChanges={hasUnsavedChanges}
      onSaveDraft={async () => markSaved()}
      onBack={() => router.push('/admin/users/new/identity')}
      onNext={() => router.push('/admin/users/new/access')}
    >
      <ValidationSummary errors={errors} />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="role" className="text-slate-200">Role</Label>
          <select
            id="role"
            value={draft.role}
            onChange={(e) => setDraft({ role: e.target.value as 'ADMIN' | 'INSTRUCTOR' | 'STUDENT' })}
            className="h-9 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none"
          >
            <option value="STUDENT">Student</option>
            <option value="INSTRUCTOR">Instructor</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="studentId" className="text-slate-200">
            Student ID {draft.role === 'STUDENT' ? '*' : '(optional)'}
          </Label>
          <Input
            id="studentId"
            value={draft.studentId}
            onChange={(e) => setDraft({ studentId: e.target.value })}
            placeholder={draft.role === 'STUDENT' ? 'STU-2026-001' : 'Not required for this role'}
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
      </div>
    </WizardShell>
  );
}
