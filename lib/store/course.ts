import { create } from 'zustand';
import type { Course, CourseChapter, ChapterUpdates, CourseFormData, CourseListItem } from '@/lib/types/course';
import { nanoid } from 'nanoid';

interface CourseState {
  courses: CourseListItem[];
  currentCourse: Course | null;
  isLoading: boolean;
  fetchCourses: () => Promise<void>;
  fetchCourse: (id: string) => Promise<void>;
  createCourse: (data: CourseFormData) => Promise<string>;
  updateCourse: (id: string, data: Partial<CourseFormData>) => Promise<void>;
  deleteCourse: (id: string) => Promise<void>;
  addChapter: (courseId: string, title: string, description: string | null) => Promise<void>;
  updateChapter: (courseId: string, chapterId: string, updates: ChapterUpdates) => Promise<void>;
  removeChapter: (courseId: string, chapterId: string) => Promise<void>;
  reorderChapters: (courseId: string, chapterIds: string[]) => Promise<void>;
}

export const useCourseStore = create<CourseState>((set, get) => ({
  courses: [],
  currentCourse: null,
  isLoading: false,

  fetchCourses: async () => {
    set({ isLoading: true });
    try {
      const res = await fetch('/api/course');
      if (!res.ok) throw new Error('Failed to fetch courses');
      const courses = await res.json();
      set({ courses, isLoading: false });
    } catch (error) {
      console.error('fetchCourses failed:', error);
      set({ isLoading: false });
    }
  },

  fetchCourse: async (id: string) => {
    set({ isLoading: true });
    try {
      const res = await fetch(`/api/course?id=${id}`);
      if (!res.ok) throw new Error('Failed to fetch course');
      const course = await res.json();
      set({ currentCourse: course, isLoading: false });
    } catch (error) {
      console.error('fetchCourse failed:', error);
      set({ isLoading: false });
    }
  },

  createCourse: async (data) => {
    const id = `course_${nanoid(10)}`;
    const course: Course = {
      ...data,
      chapters: [],
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fetch('/api/course', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(course),
    });
    await get().fetchCourses();
    return id;
  },

  updateCourse: async (id, data) => {
    const course = get().currentCourse;
    if (!course) return;
    const updated = { ...course, ...data, updatedAt: new Date().toISOString() };
    set({ currentCourse: updated });
    set((state) => ({
      courses: state.courses.map((c) => (c.id === id ? { ...c, ...data } : c)),
    }));
    await fetch('/api/course', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
  },

  deleteCourse: async (id) => {
    await fetch(`/api/course?id=${id}`, { method: 'DELETE' });
    await get().fetchCourses();
  },

  addChapter: async (courseId, title, description) => {
    await fetch('/api/course/chapters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId, title, description }),
    });
    await get().fetchCourse(courseId);
  },

  updateChapter: async (courseId, chapterId, updates) => {
    await fetch('/api/course/chapters', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId, chapterId, ...updates }),
    });
    await get().fetchCourse(courseId);
  },

  removeChapter: async (courseId, chapterId) => {
    await fetch('/api/course/chapters', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId, chapterId }),
    });
    await get().fetchCourse(courseId);
  },

  reorderChapters: async (courseId, chapterIds) => {
    await fetch('/api/course/chapters', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId, chapterIds }),
    });
    await get().fetchCourse(courseId);
  },
}));
