import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage, SlideContent } from '@/lib/types/stage';
import type { Slide } from '@/lib/types/slides';
import type { SceneOutline } from '@/lib/types/generation';

function resolveProjectRoot(): string {
  const explicitRoot = process.env.OPENMAIC_PROJECT_ROOT;
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const cwd = process.cwd();
  const standaloneSuffix = `${path.sep}.next${path.sep}standalone`;
  if (cwd.endsWith(standaloneSuffix)) {
    return path.resolve(cwd, '..', '..');
  }

  return cwd;
}

export const PROJECT_ROOT = resolveProjectRoot();
export const CLASSROOMS_DIR = path.join(PROJECT_ROOT, 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(PROJECT_ROOT, 'data', 'classroom-jobs');

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

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  outlines?: SceneOutline[];
  createdAt: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function classroomExists(id: string): Promise<boolean> {
  const newPath = path.join(CLASSROOMS_DIR, id, 'classroom.json');
  try { await fs.access(newPath); return true; } catch {}
  const oldPath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try { await fs.access(oldPath); return true; } catch {}
  return false;
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  // New path: data/classrooms/{id}/classroom.json
  const newPath = path.join(CLASSROOMS_DIR, id, 'classroom.json');
  try {
    const content = await fs.readFile(newPath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Fallback: old path data/classrooms/{id}.json
  const oldPath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(oldPath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface ClassroomListItem {
  id: string;
  name: string;
  description?: string;
  language?: string;
  sceneCount: number;
  createdAt: string;
  firstSlide?: Slide | null;
}

function getDisplayClassroomName(data: PersistedClassroomData): string {
  const rawName = data.stage?.name?.trim() || '';
  const fallbackTitle =
    data.scenes?.find((scene) => scene.title?.trim())?.title?.trim() || data.id || 'Untitled';

  if (!rawName) return fallbackTitle;

  const firstLine = rawName.split(/\r?\n/, 1)[0]?.trim() || '';
  const looksLikeReferenceBlob =
    rawName.startsWith('参考资料{') ||
    /\n#{1,6}\s/.test(rawName) ||
    /\n[-*]\s/.test(rawName);

  if (looksLikeReferenceBlob) return fallbackTitle;
  return firstLine || fallbackTitle;
}

export async function listClassrooms(): Promise<ClassroomListItem[]> {
  await ensureClassroomsDir();
  const entries = await fs.readdir(CLASSROOMS_DIR, { withFileTypes: true });
  const items: ClassroomListItem[] = [];

  // New format: subdirectories with classroom.json
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const jsonPath = path.join(CLASSROOMS_DIR, entry.name, 'classroom.json');
      try {
        const content = await fs.readFile(jsonPath, 'utf-8');
        const data = JSON.parse(content) as PersistedClassroomData;
        const firstSlideScene = data.scenes?.find(s => s.content?.type === 'slide');
        items.push({
          id: data.id,
          name: getDisplayClassroomName(data),
          description: data.stage?.description,
          language: data.stage?.language,
          sceneCount: data.scenes?.length || 0,
          createdAt: data.createdAt,
          firstSlide: firstSlideScene?.content?.type === 'slide'
            ? (firstSlideScene.content as SlideContent).canvas
            : null,
        });
      } catch { /* skip if no classroom.json */ }
    }
  }

  // Backward compat: also read old flat .json files
  for (const entry of entries) {
    if (!entry.isDirectory() && entry.name.endsWith('.json')) {
      const id = entry.name.replace('.json', '');
      if (items.some(item => item.id === id)) continue; // already found in new format
      try {
        const content = await fs.readFile(path.join(CLASSROOMS_DIR, entry.name), 'utf-8');
        const data = JSON.parse(content) as PersistedClassroomData;
        const firstSlideScene = data.scenes?.find(s => s.content?.type === 'slide');
        items.push({
          id: data.id,
          name: getDisplayClassroomName(data),
          description: data.stage?.description,
          language: data.stage?.language,
          sceneCount: data.scenes?.length || 0,
          createdAt: data.createdAt,
          firstSlide: firstSlideScene?.content?.type === 'slide'
            ? (firstSlideScene.content as SlideContent).canvas
            : null,
        });
      } catch { /* skip corrupt files */ }
    }
  }

  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return items;
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
    outlines?: SceneOutline[];
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    outlines: data.outlines,
    createdAt: new Date().toISOString(),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, data.id, 'classroom.json');
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
