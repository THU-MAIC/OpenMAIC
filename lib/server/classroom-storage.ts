import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';
import type { ClassroomContentProof } from '@/lib/server/classroom-content-review';
import {
  ClassroomAudioImportError,
  prepareClassroomAudioAssets,
  persistClassroomAudioAssets,
} from '@/lib/server/classroom-audio-import';

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

export async function writeJsonFileAtomic(filePath: string, data: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  try {
    signal?.throwIfAborted();
    await fs.writeFile(tempFilePath, content, { encoding: 'utf-8', signal });
    signal?.throwIfAborted();
    await fs.rename(tempFilePath, filePath);
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => {});
    throw error;
  }
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
  createdAt: string;
  contentReview?: ClassroomContentProof;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
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
    audioAssets?: unknown;
  },
  baseUrl: string,
  options: {
    signal?: AbortSignal;
    contentReview?: ClassroomContentProof;
    validateBeforeWrite?: (material: { stage: Stage; scenes: Scene[] }) => void;
  } = {},
): Promise<PersistedClassroomData & { url: string }> {
  options.signal?.throwIfAborted();
  if (typeof data.id !== 'string' || !isValidClassroomId(data.id)) {
    throw new ClassroomAudioImportError('Invalid classroom id');
  }
  const scenes = structuredClone(data.scenes);
  const audioAssets = prepareClassroomAudioAssets(scenes, data.audioAssets);
  await persistClassroomAudioAssets(
    audioAssets,
    path.join(CLASSROOMS_DIR, data.id, 'audio'),
    `/api/classroom-media/${data.id}/audio`,
    scenes,
  );
  options.signal?.throwIfAborted();
  options.validateBeforeWrite?.({ stage: data.stage, scenes });
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes,
    createdAt: new Date().toISOString(),
    ...(options.contentReview ? { contentReview: options.contentReview } : {}),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
  options.signal?.throwIfAborted();
  await writeJsonFileAtomic(filePath, classroomData, options.signal);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
