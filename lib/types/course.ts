export const COURSE_CHAPTER_CONTEXT_KEY = 'courseChapterContext';

export interface CourseChapterContext {
  courseId: string;
  chapterId: string;
  stageId: string | null;
  createdAt: number;
}

export interface ClassroomMeta {
  name: string;
  sceneCount: number;
  published: boolean;
}

/** Updates accepted by the updateChapter API. null means "clear the field". */
export interface ChapterUpdates {
  title?: string;
  description?: string | null;
  classroomId?: string | null;
}

export interface CourseChapter {
  id: string;
  title: string;
  description?: string;
  order: number;
  classroomId?: string; // only published classrooms (server-persisted)
}

export interface CourseFormData {
  name: string;
  college: string;
  major: string;
  description: string;
  teacherName: string;
}

export interface Course {
  id: string;
  name: string;
  college: string;
  major: string;
  description: string;
  teacherName: string;
  chapters: CourseChapter[];
  createdAt: string;
  updatedAt: string;
}

export type CourseListItem = Omit<Course, 'chapters' | 'updatedAt'> & {
  chapterCount: number;
};
