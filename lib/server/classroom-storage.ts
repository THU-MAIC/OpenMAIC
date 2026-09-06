import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import type { Scene, Stage } from '@/lib/types/stage';

const log = createLogger('ClassroomStorage');

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

/**
 * Fallback read: load a classroom from the server DocumentStore (PostgreSQL).
 *
 * Pro workbench (agent-runtime) courses are persisted to the owner-bound
 * `PgDocumentStore`, NOT to `data/classrooms/*.json`. The standalone
 * `/classroom/{id}` page loads via `/api/classroom?id=` (JSON store only), so a
 * Postgres-only course would 404 as "Classroom not found". This reads the
 * course's owner from `document_stages` and loads through `forOwner(...)`,
 * reusing `loadDocument`'s reassembly/migration. Returns `null` (never throws)
 * when the course is absent or the store is unreachable, so callers degrade to
 * 404 exactly like a JSON miss.
 */
export async function loadClassroomFromDocumentStore(
  id: string,
): Promise<{ stage: Stage; scenes: Scene[] } | null> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  try {
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const provider = await getServerPersistenceProvider(connectionString);

    const ownerRows = await provider.pool.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM document_stages WHERE id = $1',
      [id],
    );
    const owner = ownerRows.rows[0]?.owner_id ?? null;
    const doc = owner
      ? await provider.documentStore.forOwner(owner).loadDocument(id)
      : await provider.documentStore.loadDocument(id);
    if (!doc) return null;

    return {
      // ReassembleDocument yields the DSL stage/scene shapes; the classroom
      // payload carries the app shapes, validated by the same validators that
      // back the store, so the cast is a type-boundary only.
      stage: doc.stage as unknown as Stage,
      scenes: doc.scenes as unknown as Scene[],
    };
  } catch (error) {
    log.warn(`DocumentStore classroom fallback failed for ${id}:`, error);
    return null;
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
