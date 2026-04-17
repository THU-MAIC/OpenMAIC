'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export interface PendingStudent {
  name: string;
  studentId?: string;
  email?: string;
  /** If linked to a DB user, their user ID */
  dbUserId?: string;
}

interface WizardState {
  title: string;
  description: string;
  language: 'en' | 'zh-CN' | 'th-TH';
  pendingStudents: PendingStudent[];
  pacingMode: 'self_paced' | 'scheduled';
  startAt: string;
  endAt: string;
}

interface ClassroomWizardContextValue extends WizardState {
  setTitle: (v: string) => void;
  setDescription: (v: string) => void;
  setLanguage: (v: 'en' | 'zh-CN' | 'th-TH') => void;
  addStudent: (s: PendingStudent) => void;
  removeStudent: (index: number) => void;
  setPacingMode: (v: 'self_paced' | 'scheduled') => void;
  setStartAt: (v: string) => void;
  setEndAt: (v: string) => void;
  reset: () => void;
}

const defaultState: WizardState = {
  title: '',
  description: '',
  language: 'en',
  pendingStudents: [],
  pacingMode: 'self_paced',
  startAt: '',
  endAt: '',
};

const ClassroomWizardContext = createContext<ClassroomWizardContextValue | null>(null);

export function ClassroomWizardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WizardState>(defaultState);

  const setTitle = useCallback((v: string) => {
    setState((s) => ({ ...s, title: v }));
  }, []);

  const setDescription = useCallback((v: string) => {
    setState((s) => ({ ...s, description: v }));
  }, []);

  const setLanguage = useCallback((v: 'en' | 'zh-CN' | 'th-TH') => {
    setState((s) => ({ ...s, language: v }));
  }, []);

  const addStudent = useCallback((student: PendingStudent) => {
    setState((s) => ({ ...s, pendingStudents: [...s.pendingStudents, student] }));
  }, []);

  const removeStudent = useCallback((index: number) => {
    setState((s) => ({
      ...s,
      pendingStudents: s.pendingStudents.filter((_, i) => i !== index),
    }));
  }, []);

  const setPacingMode = useCallback((v: 'self_paced' | 'scheduled') => {
    setState((s) => ({ ...s, pacingMode: v }));
  }, []);

  const setStartAt = useCallback((v: string) => {
    setState((s) => ({ ...s, startAt: v }));
  }, []);

  const setEndAt = useCallback((v: string) => {
    setState((s) => ({ ...s, endAt: v }));
  }, []);

  const reset = useCallback(() => {
    setState(defaultState);
  }, []);

  return (
    <ClassroomWizardContext.Provider
      value={{ ...state, setTitle, setDescription, setLanguage, addStudent, removeStudent, setPacingMode, setStartAt, setEndAt, reset }}
    >
      {children}
    </ClassroomWizardContext.Provider>
  );
}

export function useClassroomWizard(): ClassroomWizardContextValue {
  const ctx = useContext(ClassroomWizardContext);
  if (!ctx) throw new Error('useClassroomWizard must be used inside ClassroomWizardProvider');
  return ctx;
}
