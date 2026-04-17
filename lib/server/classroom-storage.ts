import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');
export const DELETED_CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms-deleted');
const DELETED_INDEX_FILE = path.join(DELETED_CLASSROOMS_DIR, 'index.json');
const DELETED_RETENTION_DAYS = 180;
const DELETED_RETENTION_MS = DELETED_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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
  createdAt: string;
}

export interface DeletedClassroomRecord {
  id: string;
  ownerUserId: string;
  deletedBy: string;
  deletedAt: string;
  purgeAt: string;
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
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}

function getClassroomFilePath(id: string) {
  return path.join(CLASSROOMS_DIR, `${id}.json`);
}

function getDeletedClassroomFilePath(id: string) {
  return path.join(DELETED_CLASSROOMS_DIR, `${id}.json`);
}

async function readDeletedIndex(): Promise<DeletedClassroomRecord[]> {
  try {
    const content = await fs.readFile(DELETED_INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(content) as DeletedClassroomRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeDeletedIndex(records: DeletedClassroomRecord[]) {
  await ensureDir(DELETED_CLASSROOMS_DIR);
  await writeJsonFileAtomic(DELETED_INDEX_FILE, records);
}

export async function purgeExpiredDeletedClassrooms() {
  const now = Date.now();
  const records = await readDeletedIndex();
  const keep: DeletedClassroomRecord[] = [];
  const purge: DeletedClassroomRecord[] = [];

  for (const record of records) {
    if (new Date(record.purgeAt).getTime() <= now) purge.push(record);
    else keep.push(record);
  }

  for (const record of purge) {
    const deletedPath = getDeletedClassroomFilePath(record.id);
    try {
      await fs.unlink(deletedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (purge.length > 0) {
    await writeDeletedIndex(keep);
  }

  return { purgedCount: purge.length };
}

export async function softDeleteClassroom(params: {
  id: string;
  ownerUserId: string;
  deletedBy: string;
}) {
  await ensureDir(CLASSROOMS_DIR);
  await ensureDir(DELETED_CLASSROOMS_DIR);
  await purgeExpiredDeletedClassrooms();

  const source = getClassroomFilePath(params.id);
  const destination = getDeletedClassroomFilePath(params.id);

  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleted: false as const };
    }
    throw error;
  }

  const deletedAt = new Date();
  const purgeAt = new Date(deletedAt.getTime() + DELETED_RETENTION_MS);
  const record: DeletedClassroomRecord = {
    id: params.id,
    ownerUserId: params.ownerUserId,
    deletedBy: params.deletedBy,
    deletedAt: deletedAt.toISOString(),
    purgeAt: purgeAt.toISOString(),
  };

  const records = await readDeletedIndex();
  const next = [...records.filter((r) => r.id !== params.id), record];
  await writeDeletedIndex(next);

  return { deleted: true as const, record };
}

export async function listDeletedClassrooms() {
  await ensureDir(DELETED_CLASSROOMS_DIR);
  await purgeExpiredDeletedClassrooms();
  const records = await readDeletedIndex();
  return records.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
}

export async function restoreDeletedClassroom(id: string) {
  await ensureDir(CLASSROOMS_DIR);
  await ensureDir(DELETED_CLASSROOMS_DIR);
  await purgeExpiredDeletedClassrooms();

  const records = await readDeletedIndex();
  const target = records.find((r) => r.id === id);
  if (!target) return null;

  const source = getDeletedClassroomFilePath(id);
  const destination = getClassroomFilePath(id);

  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  await writeDeletedIndex(records.filter((r) => r.id !== id));
  return target;
}
