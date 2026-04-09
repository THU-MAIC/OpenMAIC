import { create } from 'zustand';
import type { CompleteCourse, CourseModule, CourseCollaborator, CoursePhilosophy } from '@/lib/types/course';
import { BUILT_IN_PHILOSOPHIES } from '@/lib/course/philosophies';

interface CourseState {
  currentCourse: CompleteCourse | null;
  currentModuleId: string | null;
  philosophies: CoursePhilosophy[];

  setCourse: (course: CompleteCourse) => void;
  clearCourse: () => void;
  setCurrentModule: (moduleId: string | null) => void;
  addModule: (module: CourseModule) => void;
  updateModule: (moduleId: string, updates: Partial<CourseModule>) => void;
  removeModule: (moduleId: string) => void;
  reorderModules: (orderedIds: string[]) => void;
  setPhilosophy: (philosophyId: string) => void;
  addCollaborator: (collaborator: CourseCollaborator) => void;
  removeCollaborator: (id: string) => void;

  saveCourse: () => Promise<void>;
  loadCourse: (courseId: string) => Promise<void>;
}

export const useCourseStore = create<CourseState>((set, get) => ({
  currentCourse: null,
  currentModuleId: null,
  philosophies: BUILT_IN_PHILOSOPHIES,

  setCourse: (course) => set({ currentCourse: course }),
  clearCourse: () => set({ currentCourse: null, currentModuleId: null }),
  setCurrentModule: (moduleId) => set({ currentModuleId: moduleId }),

  addModule: (module) => {
    const { currentCourse } = get();
    if (!currentCourse) return;
    set({
      currentCourse: {
        ...currentCourse,
        modules: [...currentCourse.modules, module],
        updatedAt: Date.now(),
      },
    });
  },

  updateModule: (moduleId, updates) => {
    const { currentCourse } = get();
    if (!currentCourse) return;
    set({
      currentCourse: {
        ...currentCourse,
        modules: currentCourse.modules.map((m) => (m.id === moduleId ? { ...m, ...updates } : m)),
        updatedAt: Date.now(),
      },
    });
  },

  removeModule: (moduleId) => {
    const { currentCourse } = get();
    if (!currentCourse) return;
    set({
      currentCourse: {
        ...currentCourse,
        modules: currentCourse.modules.filter((m) => m.id !== moduleId),
        updatedAt: Date.now(),
      },
    });
  },

  reorderModules: (orderedIds) => {
    const { currentCourse } = get();
    if (!currentCourse) return;
    const map = new Map(currentCourse.modules.map((m) => [m.id, m]));
    const reordered = orderedIds
      .map((id, idx) => {
        const m = map.get(id);
        return m ? { ...m, order: idx } : null;
      })
      .filter((m): m is CourseModule => m !== null);
    set({
      currentCourse: { ...currentCourse, modules: reordered, updatedAt: Date.now() },
    });
  },

  setPhilosophy: (philosophyId) => {
    const { currentCourse, philosophies } = get();
    if (!currentCourse) return;
    const philosophy = philosophies.find((p) => p.id === philosophyId);
    set({
      currentCourse: {
        ...currentCourse,
        philosophyId,
        philosophy,
        updatedAt: Date.now(),
      },
    });
  },

  addCollaborator: (collaborator) => {
    const { currentCourse } = get();
    if (!currentCourse) return;
    set({
      currentCourse: {
        ...currentCourse,
        collaborators: [...currentCourse.collaborators, collaborator],
        updatedAt: Date.now(),
      },
    });
  },

  removeCollaborator: (id) => {
    const { currentCourse } = get();
    if (!currentCourse) return;
    set({
      currentCourse: {
        ...currentCourse,
        collaborators: currentCourse.collaborators.filter((c) => c.id !== id),
        updatedAt: Date.now(),
      },
    });
  },

  saveCourse: async () => {
    const { currentCourse } = get();
    if (!currentCourse) return;
    await fetch(`/api/courses/${currentCourse.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentCourse),
    });
  },

  loadCourse: async (courseId) => {
    const res = await fetch(`/api/courses/${courseId}`);
    if (!res.ok) return;
    const data = await res.json();
    set({ currentCourse: data.course });
  },
}));
