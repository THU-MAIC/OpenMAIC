'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  defaultUserWizardDraft,
  getIdentityErrors,
  getRoleErrors,
  getSecurityErrors,
  type UserWizardDraft,
} from '@/lib/admin/user-wizard';

interface AdminUserWizardState {
  draft: UserWizardDraft;
  hasUnsavedChanges: boolean;
  setDraft: (patch: Partial<UserWizardDraft>) => void;
  setClassroomIds: (ids: string[]) => void;
  markSaved: () => void;
  reset: () => void;
  getStepState: (stepId: string) => 'todo' | 'active' | 'valid' | 'error';
}

export const useAdminUserWizardStore = create<AdminUserWizardState>()(
  persist(
    (set, get) => ({
      draft: defaultUserWizardDraft,
      hasUnsavedChanges: false,
      setDraft: (patch) =>
        set((state) => ({
          draft: { ...state.draft, ...patch },
          hasUnsavedChanges: true,
        })),
      setClassroomIds: (ids) =>
        set((state) => ({
          draft: { ...state.draft, classroomIds: ids },
          hasUnsavedChanges: true,
        })),
      markSaved: () => set({ hasUnsavedChanges: false }),
      reset: () => set({ draft: defaultUserWizardDraft, hasUnsavedChanges: false }),
      getStepState: (stepId) => {
        const { draft } = get();
        if (stepId === 'identity') return getIdentityErrors(draft).length ? 'error' : 'valid';
        if (stepId === 'role') return getRoleErrors(draft).length ? 'error' : 'valid';
        if (stepId === 'security') return getSecurityErrors(draft).length ? 'error' : 'valid';
        return 'todo';
      },
    }),
    { name: 'admin-user-wizard-v1' },
  ),
);
