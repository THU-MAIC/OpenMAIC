/**
 * Course Storage - File-based JSON persistence for complete courses.
 * Mirrors the pattern from `lib/server/classroom-storage.ts`.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type { CompleteCourse } from '@/lib/types/course';

const COURSES_DIR = path.join(process.cwd(), 'data', 'courses');

async function ensureDir() {
  await fs.mkdir(COURSES_DIR, { recursive: true });
}

function coursePath(id: string): string {
  // Allow only safe characters in IDs to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid course id: ${id}`);
  }
  return path.join(COURSES_DIR, `${id}.json`);
}

export async function readCourse(id: string): Promise<CompleteCourse | null> {
  try {
    const buf = await fs.readFile(coursePath(id), 'utf-8');
    return JSON.parse(buf) as CompleteCourse;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function persistCourse(course: CompleteCourse): Promise<void> {
  await ensureDir();
  const tmp = `${coursePath(course.id)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(course, null, 2), 'utf-8');
  await fs.rename(tmp, coursePath(course.id));
}

export async function listCourses(): Promise<CompleteCourse[]> {
  await ensureDir();
  const files = await fs.readdir(COURSES_DIR);
  const courses: CompleteCourse[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const buf = await fs.readFile(path.join(COURSES_DIR, f), 'utf-8');
      courses.push(JSON.parse(buf));
    } catch {
      // Skip corrupt files
    }
  }
  return courses.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteCourse(id: string): Promise<void> {
  try {
    await fs.unlink(coursePath(id));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
