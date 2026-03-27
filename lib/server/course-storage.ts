import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import type { Course, CourseChapter, ChapterUpdates, CourseListItem } from '@/lib/types/course';
import { PROJECT_ROOT, writeJsonFileAtomic } from './classroom-storage';
import { withCourseLock } from './course-lock';

const COURSES_DIR = path.join(PROJECT_ROOT, 'data', 'courses');

async function ensureCoursesDir() {
  await fs.mkdir(COURSES_DIR, { recursive: true });
}

// Migrate old-format course (classroomIds[]) to new format (chapters[]).
// Writes back immediately to stabilize chapter IDs.
async function migrateCourseIfNeeded(
  filePath: string,
  raw: Record<string, unknown>,
): Promise<Course> {
  if (Array.isArray((raw as unknown as Course).chapters)) return raw as unknown as Course;
  const ids = (raw.classroomIds as string[] | undefined) ?? [];
  const chapters: CourseChapter[] = ids.map((cid, i) => ({
    id: nanoid(10),
    title: `第 ${i + 1} 章`,
    order: i,
    classroomId: cid,
  }));
  const { classroomIds: _removed, ...rest } = raw;
  const migrated = { ...(rest as Omit<Course, 'chapters'>), chapters } as Course;
  await writeJsonFileAtomic(filePath, migrated);
  return migrated;
}

export async function persistCourse(course: Course): Promise<void> {
  await ensureCoursesDir();
  const filePath = path.join(COURSES_DIR, `${course.id}.json`);
  await writeJsonFileAtomic(filePath, course);
}

export async function readCourse(id: string): Promise<Course | null> {
  const filePath = path.join(COURSES_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;
    return await migrateCourseIfNeeded(filePath, raw);
  } catch {
    return null;
  }
}

export async function listCourses(): Promise<CourseListItem[]> {
  await ensureCoursesDir();
  try {
    const files = await fs.readdir(COURSES_DIR);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const courses = await Promise.all(
      jsonFiles.map(async (file) => {
        const filePath = path.join(COURSES_DIR, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const raw = JSON.parse(content) as Record<string, unknown>;
          const course = await migrateCourseIfNeeded(filePath, raw);
          return {
            id: course.id,
            name: course.name,
            college: course.college,
            major: course.major,
            description: course.description,
            teacherName: course.teacherName,
            chapterCount: course.chapters.length,
            createdAt: course.createdAt,
          } satisfies CourseListItem;
        } catch {
          return null;
        }
      }),
    );

    return courses
      .filter((c): c is CourseListItem => c !== null)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch {
    return [];
  }
}

export async function deleteCourse(id: string): Promise<void> {
  const filePath = path.join(COURSES_DIR, `${id}.json`);
  await fs.unlink(filePath);
}

export async function addChapter(
  courseId: string,
  data: { title: string; description?: string },
): Promise<CourseChapter> {
  return withCourseLock(courseId, async () => {
    const course = await readCourse(courseId);
    if (!course) throw new Error('Course not found');
    const chapter: CourseChapter = {
      id: nanoid(10),
      title: data.title,
      description: data.description,
      order: course.chapters.length,
    };
    course.chapters.push(chapter);
    course.updatedAt = new Date().toISOString();
    await persistCourse(course);
    return chapter;
  });
}

export async function updateChapter(
  courseId: string,
  chapterId: string,
  updates: ChapterUpdates,
): Promise<void> {
  await withCourseLock(courseId, async () => {
    const course = await readCourse(courseId);
    if (!course) throw new Error('Course not found');
    const chapter = course.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error('Chapter not found');
    if (updates.title !== undefined) chapter.title = updates.title;
    if ('description' in updates) {
      if (updates.description === null || updates.description === undefined) {
        delete chapter.description;
      } else {
        chapter.description = updates.description;
      }
    }
    if ('classroomId' in updates) {
      if (updates.classroomId === null || updates.classroomId === undefined) {
        delete chapter.classroomId;
      } else {
        chapter.classroomId = updates.classroomId;
      }
    }
    course.updatedAt = new Date().toISOString();
    await persistCourse(course);
  });
}

export async function removeChapter(courseId: string, chapterId: string): Promise<void> {
  await withCourseLock(courseId, async () => {
    const course = await readCourse(courseId);
    if (!course) throw new Error('Course not found');
    course.chapters = course.chapters
      .filter((c) => c.id !== chapterId)
      .map((c, i) => ({ ...c, order: i }));
    course.updatedAt = new Date().toISOString();
    await persistCourse(course);
  });
}

export async function reorderChapters(courseId: string, chapterIds: string[]): Promise<void> {
  await withCourseLock(courseId, async () => {
    const course = await readCourse(courseId);
    if (!course) throw new Error('Course not found');
    const chapterMap = new Map(course.chapters.map((c) => [c.id, c]));
    course.chapters = chapterIds
      .filter((id) => chapterMap.has(id))
      .map((id, i) => ({ ...chapterMap.get(id)!, order: i }));
    course.updatedAt = new Date().toISOString();
    await persistCourse(course);
  });
}
