import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

/**
 * Derive the public-facing origin for URL construction.
 *
 * Prefers the explicit NEXT_PUBLIC_BASE_URL env var (always safe).
 * Falls back to x-forwarded-host/proto only when running behind a
 * trusted reverse proxy (Vercel sets these automatically).
 * As a last resort, uses the request's own origin.
 */
export function buildRequestOrigin(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, '');
  }

  const forwardedHost = req.headers.get('x-forwarded-host');
  if (forwardedHost) {
    // Basic sanity: host must look like a hostname (no path, no whitespace)
    if (/^[\w.:-]+$/.test(forwardedHost)) {
      const proto = req.headers.get('x-forwarded-proto') || 'https';
      if (proto === 'http' || proto === 'https') {
        return `${proto}://${forwardedHost}`;
      }
    }
  }

  return req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  if (!isValidClassroomId(id)) return null;

  const filePath = path.resolve(CLASSROOMS_DIR, `${id}.json`);
  if (!filePath.startsWith(path.resolve(CLASSROOMS_DIR) + path.sep)) {
    return null;
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  if (!isValidClassroomId(data.id)) {
    throw new Error(`Invalid classroom id: ${data.id}`);
  }

  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  await ensureClassroomsDir();
  const filePath = path.resolve(CLASSROOMS_DIR, `${data.id}.json`);

  // Defense-in-depth: ensure resolved path stays under the classrooms directory
  if (!filePath.startsWith(path.resolve(CLASSROOMS_DIR) + path.sep)) {
    throw new Error('Path traversal detected');
  }

  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
