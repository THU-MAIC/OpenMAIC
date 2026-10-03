/**
 * Where a server-side classroom lands: the owner's server course library.
 *
 * A classroom imported from the file store of earlier versions is an ordinary
 * course document, written once, complete, through the owner-bound document
 * store. That is what
 * makes it appear in the owner's library, open at `/classroom/<id>` through the
 * normal load path, and count as the owner's for every later edit. Its media
 * are asset-pool entries the caller allocated for the same owner; the document
 * write is what commits them (`lib/server/store-generated-asset.ts`).
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { getBackgroundDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

/** A fresh course id, in the same `stage-` family as `POST /api/stages`. */
export function generateClassroomId(): string {
  return `stage-${randomBytes(9).toString('base64url')}`;
}

export interface CompletedClassroom {
  stage: Stage;
  scenes: Scene[];
  outlines: SceneOutline[];
}

/**
 * Create a finished classroom as a new course of `ownerId`, and return what
 * was stored.
 *
 * Create-only: when any course already holds the id (this owner's, another
 * owner's, or a deleted one) nothing is written and `StageIdTakenError` is
 * thrown, so a concurrent create of the same id is never replaced. The
 * outline is saved complete (`generationComplete: true`) and the ownership
 * row's mirror of that flag is set in the same transaction, together with
 * whatever `inTransaction` writes, so no browser that opens the course tries
 * to generate pages for it. Every HTML-bearing field passes the scene-content
 * sanitizer on the way in: this content never went through an editor.
 *
 * The store is the background one: the owner may be claimed into an account
 * while the import runs, and the course then lands in that account. A host
 * `authorizeCreate` refusal, a retired owner, and every other store failure
 * throw; nothing is written then.
 */
export async function saveCompletedClassroom(
  ownerId: string,
  classroom: CompletedClassroom,
  options: { inTransaction?: (queryable: Queryable) => Promise<void> } = {},
): Promise<{ stage: Stage; scenes: Scene[] }> {
  const stage = sanitizeSceneContent(classroom.stage);
  const scenes = sanitizeSceneContent(classroom.scenes);
  const now = Date.now();
  const outline: AppDocumentOutline = {
    outlines: classroom.outlines,
    generationComplete: true,
    createdAt: stage.createdAt ?? now,
    updatedAt: now,
  };
  const store = await getBackgroundDocumentStore(ownerId);
  await store.createDocument({ stage, scenes, outline }, { inTransaction: options.inTransaction });
  return { stage, scenes };
}
