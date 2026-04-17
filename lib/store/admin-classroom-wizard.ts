'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  defaultClassroomWizardDraft,
  getBasicsErrors,
  getContentErrors,
  getScheduleErrors,
  type ClassroomWizardDraft,
} from '@/lib/admin/classroom-wizard';

interface AdminClassroomWizardState {
  draft: ClassroomWizardDraft;
  hasUnsavedChanges: boolean;
  setDraft: (patch: Partial<ClassroomWizardDraft>) => void;
  markSaved: () => void;
  reset: () => void;
  getStepState: (stepId: string) => 'todo' | 'active' | 'valid' | 'error';
}

export const useAdminClassroomWizardStore = create<AdminClassroomWizardState>()(
  persist(
    (set, get) => ({
      draft: defaultClassroomWizardDraft,
      hasUnsavedChanges: false,
      setDraft: (patch) =>
        set((state) => ({
          draft: { ...state.draft, ...patch },
          hasUnsavedChanges: true,
        })),
      markSaved: () => set({ hasUnsavedChanges: false }),
      reset: () => set({ draft: defaultClassroomWizardDraft, hasUnsavedChanges: false }),
      getStepState: (stepId) => {
        const { draft } = get();
        if (stepId === 'basics') return getBasicsErrors(draft).length ? 'error' : 'valid';
        if (stepId === 'content') return getContentErrors(draft).length ? 'error' : 'valid';
        if (stepId === 'schedule') return getScheduleErrors(draft).length ? 'error' : 'valid';
        return 'todo';
      },
    }),
    { name: 'admin-classroom-wizard-v1' },
  ),
);
