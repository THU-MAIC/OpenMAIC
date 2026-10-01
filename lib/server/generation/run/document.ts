/**
 * The course document a run produces, written through the owner-bound
 * document store of background work (a claim during the run moves the course
 * to the account, as it moves every other course).
 *
 * The document is created when the first scene is ready, at the moment the
 * browser navigates to the classroom, and marked as produced by a server job
 * so no browser generates into it; every later scene is appended as it
 * completes, and `generationComplete` is set at the end. Every write is fenced
 * by the run's lease, so a worker whose run was taken over cannot write.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { readStageMeta } from '@/lib/persistence/stage-meta';
import { StageAccessError } from '@/lib/persistence/stage-meta';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getBackgroundDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

import { assertGenerationRunLease, type RunLease } from './store';

/** The course was deleted while its run was generating. */
export class RunCourseDeletedError extends Error {
  constructor(readonly stageId: string) {
    super(`The course ${stageId} was deleted`);
    this.name = 'RunCourseDeletedError';
  }
}

function courseGone(error: unknown): boolean {
  return (
    error instanceof StageAccessError &&
    (error.refusal === 'tombstoned' || error.refusal === 'unclaimed')
  );
}

function fencedStore(ownerId: string, lease: RunLease) {
  return getBackgroundDocumentStore(ownerId, (tx) => assertGenerationRunLease(tx, lease));
}

/**
 * Create the course with its first scene. `inTransaction` runs on the create's
 * transaction (the run's checkpoint), so the course and the checkpoint that
 * records it commit together.
 */
export async function createRunCourse(input: {
  ownerId: string;
  lease: RunLease;
  stage: Stage;
  outlines: SceneOutline[];
  firstScene: Scene;
  inTransaction: (queryable: Queryable) => Promise<void>;
}): Promise<void> {
  const now = Date.now();
  const outline: AppDocumentOutline = {
    outlines: input.outlines,
    generationComplete: false,
    producer: 'server-job',
    producerRef: input.lease.runId,
    createdAt: now,
    updatedAt: now,
  };
  const store = await fencedStore(input.ownerId, input.lease);
  await store.createDocument(
    {
      stage: sanitizeSceneContent(input.stage),
      scenes: [sanitizeSceneContent(input.firstScene)],
      outline,
    },
    { inTransaction: input.inTransaction },
  );
}

/** Append (or, on a retried append, rewrite) one scene. */
export async function appendRunScene(input: {
  ownerId: string;
  lease: RunLease;
  stageId: string;
  scene: Scene;
}): Promise<void> {
  const store = await fencedStore(input.ownerId, input.lease);
  try {
    await store.putScene(input.stageId, sanitizeSceneContent(input.scene));
  } catch (error) {
    if (courseGone(error)) throw new RunCourseDeletedError(input.stageId);
    throw error;
  }
}

/** Record in the document that every scene is generated. */
export async function completeRunCourse(input: {
  ownerId: string;
  lease: RunLease;
  stageId: string;
}): Promise<void> {
  const store = await fencedStore(input.ownerId, input.lease);
  const document = await store.loadDocument(input.stageId);
  if (!document) throw new RunCourseDeletedError(input.stageId);
  const outline = (document.outline ?? {}) as AppDocumentOutline;
  try {
    await store.saveDocument({
      ...document,
      outline: { ...outline, generationComplete: true, updatedAt: Date.now() },
    });
  } catch (error) {
    if (courseGone(error)) throw new RunCourseDeletedError(input.stageId);
    throw error;
  }
}

/** Whether the run's course was deleted (a step boundary checks before going on). */
export async function isRunCourseDeleted(stageId: string): Promise<boolean> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const meta = await readStageMeta(pool as unknown as Queryable, stageId);
  return !meta || meta.deletedAt !== null;
}
