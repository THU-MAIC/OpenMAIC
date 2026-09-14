import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomStorage');

/**
 * Root directory for the file-backed classroom store. Defaults to
 * `<cwd>/data/classrooms`; `OPENMAIC_CLASSROOMS_DIR` overrides it so tests can
 * point the store at a throwaway directory instead of the repository tree.
 */
export const CLASSROOMS_DIR = process.env.OPENMAIC_CLASSROOMS_DIR
  ? path.resolve(process.env.OPENMAIC_CLASSROOMS_DIR)
  : path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

/** Id length shared by the create route and the generation pipeline. */
export const CLASSROOM_ID_LENGTH = 10;

/**
 * Number of times a creation path will regenerate an id and retry the
 * exclusive write before giving up. Collisions are astronomically unlikely
 * with a 10-character id, but the create contract must be total.
 */
export const CLASSROOM_ID_MAX_ATTEMPTS = 3;

/**
 * Generate a classroom id. Uses the same shape as the generation pipeline
 * (nanoid, 10 URL-safe characters) so both creation paths draw from one
 * alphabet and length, and every generated id satisfies
 * `isValidClassroomId`.
 */
export function generateClassroomId(): string {
  return nanoid(CLASSROOM_ID_LENGTH);
}

/**
 * Raised by the exclusive file write when a classroom already exists. `code`
 * mirrors the underlying `EEXIST` so callers that cannot rely on class
 * identity (e.g. across a mocked module boundary) can still detect it.
 */
export class ClassroomAlreadyExistsError extends Error {
  readonly code = 'EEXIST' as const;
  readonly classroomId: string;

  constructor(classroomId: string) {
    super(`Classroom "${classroomId}" already exists`);
    this.name = 'ClassroomAlreadyExistsError';
    this.classroomId = classroomId;
  }
}

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
 * Error codes that mean "this filesystem has no hard links" rather than a real
 * failure. Object-storage FUSE gateways (gcsfuse, s3fs, …) report `ENOSYS`,
 * `ENOTSUP` or `EOPNOTSUPP`; some mounts report `EPERM` for `link(2)` even when
 * it is merely unsupported; `EXDEV` covers a temp file that resolved to a
 * different mount than the destination. On these the exclusive create falls
 * back to `open(..., 'wx')`, which is exclusive everywhere. Any other code is a
 * genuine failure and propagates unchanged.
 */
const LINK_UNSUPPORTED_CODES = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);

/**
 * Create `filePath` with `data` only if it does not already exist.
 *
 * The payload is written to a temp file in the same directory and then
 * hard-linked into place. `link()` is atomic and fails with `EEXIST` when the
 * destination exists, so an existing file is never replaced, while concurrent
 * readers can only ever observe a complete document (the temp name is never
 * the target). When the filesystem cannot do hard links the same content is
 * written with an exclusive `wx` open instead — still never replacing an
 * existing file, and still atomic against `EEXIST`. The temp file is removed on
 * every path. A collision surfaces as a {@link ClassroomAlreadyExistsError}.
 */
export async function writeJsonFileExclusive(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.${nanoid(6)}.tmp`;
  const content = JSON.stringify(data, null, 2);
  try {
    await fs.writeFile(tempFilePath, content, 'utf-8');
    try {
      await fs.link(tempFilePath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !LINK_UNSUPPORTED_CODES.has(code)) {
        // Includes EEXIST, which the outer catch maps to a collision.
        throw error;
      }
      // No hard links here. `wx` is exclusive on every filesystem and has no
      // link dependency; EEXIST surfaces exactly like the link path.
      await fs.writeFile(filePath, content, { flag: 'wx' });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ClassroomAlreadyExistsError(path.basename(filePath, '.json'));
    }
    throw error;
  } finally {
    await fs.unlink(tempFilePath).catch(() => undefined);
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
  /**
   * Set only on the placeholder written by {@link reserveClassroom} before the
   * slow media/TTS phases. A reserved document is not yet a classroom;
   * {@link readClassroom} treats it as absent so an in-flight (or crashed)
   * reservation is never served as an empty classroom.
   */
  reserved?: boolean;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Resolve the on-disk JSON path for a classroom id, asserting the result stays
 * inside CLASSROOMS_DIR. The route validates ids up front, but storage must
 * not trust callers: an id carrying path separators (e.g. `..`) must never be
 * allowed to name a file outside the classrooms directory.
 */
export function resolveClassroomFilePath(id: string): string {
  const resolvedRoot = path.resolve(CLASSROOMS_DIR);
  const filePath = path.resolve(resolvedRoot, `${id}.json`);
  const rootPrefix = `${resolvedRoot}${path.sep}`;
  if (filePath !== resolvedRoot && !filePath.startsWith(rootPrefix)) {
    throw new Error(`Classroom id "${id}" resolves outside the classrooms directory`);
  }
  return filePath;
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = resolveClassroomFilePath(id);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as PersistedClassroomData;
    // A reservation is a placeholder, not a classroom: hide it so a reader that
    // somehow learns the id before generation completes gets a 404 rather than
    // an empty document.
    return parsed.reserved ? null : parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Reserve a classroom id by exclusively creating its file with a placeholder
 * document before any media/TTS generation. The reservation claims the id (and
 * therefore `<CLASSROOMS_DIR>/<id>/` too) for the lifetime of the generation,
 * so a colliding id is rejected before any file lands in another classroom's
 * directory. The caller owns the id and overwrites the placeholder with the
 * final document when generation completes.
 */
export async function reserveClassroom(id: string, stage: Stage): Promise<void> {
  const placeholder: PersistedClassroomData = {
    id,
    stage,
    scenes: [],
    createdAt: new Date().toISOString(),
    reserved: true,
  };
  await writeJsonFileExclusive(resolveClassroomFilePath(id), placeholder);
}

/**
 * Drop a reservation that will never become a classroom, e.g. when generation
 * throws before the final persist. The file is re-read first and unlinked only
 * while it is still a placeholder (`reserved: true`), so a real classroom
 * document is never deleted. A missing file is a no-op. Every other error is
 * logged and swallowed: this runs from a `finally` and must never mask the
 * failure that triggered the cleanup.
 */
export async function releaseClassroomReservation(id: string): Promise<void> {
  const filePath = resolveClassroomFilePath(id);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as PersistedClassroomData;
    if (parsed.reserved !== true) {
      return;
    }
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    log.warn(`Failed to release classroom reservation "${id}":`, error);
  }
}

export interface PersistClassroomOptions {
  /**
   * When true the classroom file is created only if the id is unused. A
   * collision raises {@link ClassroomAlreadyExistsError} instead of replacing
   * the incumbent's content. Defaults to the legacy overwrite behaviour.
   */
  exclusive?: boolean;
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
  },
  baseUrl: string,
  options: PersistClassroomOptions = {},
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  const filePath = resolveClassroomFilePath(data.id);
  await ensureClassroomsDir();
  if (options.exclusive) {
    await writeJsonFileExclusive(filePath, classroomData);
  } else {
    await writeJsonFileAtomic(filePath, classroomData);
  }

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
