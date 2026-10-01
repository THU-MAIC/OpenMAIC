/**
 * The course document a run produces, written through the owner-bound
 * document store of background work (a claim during the run moves the course
 * to the account, as it moves every other course).
 *
 * The document is created when the first scene is ready, at the moment the
 * browser navigates to the classroom, and marked as produced by a server job
 * so no browser generates into it; every later scene is appended as it
 * completes, and `generationComplete` is set at the end. Every write is fenced
 * by the run's lease and commits with the run's checkpoint, so a worker whose
 * run was taken over cannot write, and a write and its checkpoint never part.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import {
  markStageGenerationComplete,
  readStageMeta,
  StageAccessError,
} from '@/lib/persistence/stage-meta';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getBackgroundDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

import { fenceGenerationRunWriteIn, type RunLease } from './store';

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

function fencedStore(ownerId: string, lease: RunLease, stageId: string) {
  return getBackgroundDocumentStore(
    ownerId,
    (tx) => fenceGenerationRunWriteIn(tx, lease, stageId),
    lease.runId,
  );
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
  const store = await fencedStore(input.ownerId, input.lease, input.stage.id);
  await store.createDocument(
    {
      stage: sanitizeSceneContent(input.stage),
      scenes: [sanitizeSceneContent(input.firstScene)],
      outline,
    },
    { inTransaction: input.inTransaction },
  );
}

/**
 * Append (or, on a retried append, rewrite) one scene; `inTransaction` (the
 * run's checkpoint) commits with it.
 */
export async function appendRunScene(input: {
  ownerId: string;
  lease: RunLease;
  stageId: string;
  scene: Scene;
  inTransaction?: (queryable: Queryable) => Promise<void>;
}): Promise<void> {
  const store = await fencedStore(input.ownerId, input.lease, input.stageId);
  try {
    await store.putScene(input.stageId, sanitizeSceneContent(input.scene), {
      inTransaction: input.inTransaction,
    });
  } catch (error) {
    if (courseGone(error)) throw new RunCourseDeletedError(input.stageId);
    throw error;
  }
}

/**
 * A targeted read-modify-write of one scene of the course as it is now (see
 * `mutateScene` of the owner-bound document store), fenced by the lease;
 * `after` (the run's checkpoint) commits with it. Answers whether the scene
 * was written.
 */
export async function mutateRunScene(input: {
  ownerId: string;
  lease: RunLease;
  stageId: string;
  sceneId: string;
  mutate: (scene: Scene | null) => Scene | null;
  after: (queryable: Queryable, wrote: boolean) => Promise<void>;
}): Promise<boolean> {
  const store = await fencedStore(input.ownerId, input.lease, input.stageId);
  try {
    return await store.mutateScene(
      input.stageId,
      input.sceneId,
      (scene) => {
        const next = input.mutate(scene);
        return next ? sanitizeSceneContent(next) : null;
      },
      input.after,
    );
  } catch (error) {
    if (courseGone(error)) throw new RunCourseDeletedError(input.stageId);
    throw error;
  }
}

/** The course's current document, as the run's owner reads it. */
export async function loadRunCourse(input: { ownerId: string; lease: RunLease; stageId: string }) {
  const store = await fencedStore(input.ownerId, input.lease, input.stageId);
  const document = await store.loadDocument(input.stageId);
  if (!document) throw new RunCourseDeletedError(input.stageId);
  return document;
}

/**
 * Touch the stage row: its revision trigger tells an open workbench or
 * editor that the course changed, so it reads it again.
 */
export async function touchRunCourseIn(tx: Queryable, stageId: string, now = Date.now()) {
  await tx.query(
    `UPDATE document_stages
        SET updated_at = $2, data = jsonb_set(data, '{updatedAt}', to_jsonb($2::double precision))
      WHERE id = $1`,
    [stageId, now],
  );
}

/**
 * Record that every scene is generated: the document outline's and the
 * ownership row's completion flags, with the run's completion (`commit`), in
 * one transaction fenced by the lease. Only the flags change; the document is
 * not rewritten. Throws {@link RunCourseDeletedError} for a course deleted
 * since.
 */
export async function completeRunCourse(input: {
  ownerId: string;
  lease: RunLease;
  stageId: string;
  commit: (queryable: Queryable) => Promise<void>;
}): Promise<void> {
  const { withTransaction } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  await withTransaction(async (tx) => {
    // The order every course write takes its locks in: the owner's identity
    // lock, the course's ownership row, then the run row.
    await forwardOwnerWrite(tx, input.ownerId);
    await fenceGenerationRunWriteIn(tx, input.lease, input.stageId);
    const meta = await readStageMeta(tx, input.stageId);
    if (!meta || meta.deletedAt !== null) throw new RunCourseDeletedError(input.stageId);
    const now = Date.now();
    await tx.query(
      `UPDATE document_outlines
          SET data = data || jsonb_build_object('generationComplete', true, 'updatedAt', $2::bigint)
        WHERE stage_id = $1`,
      [input.stageId, now],
    );
    // An open workbench reads the completion.
    await touchRunCourseIn(tx, input.stageId, now);
    await markStageGenerationComplete(tx, input.stageId);
    await input.commit(tx);
  });
}

/** Whether the run's course was deleted (a step boundary checks before going on). */
export async function isRunCourseDeleted(stageId: string): Promise<boolean> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const meta = await readStageMeta(pool as unknown as Queryable, stageId);
  return !meta || meta.deletedAt !== null;
}
