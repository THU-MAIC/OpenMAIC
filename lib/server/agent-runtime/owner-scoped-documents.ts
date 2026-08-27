import type {
  DocumentFolderStore,
  DocumentStore,
  StageFreshnessManifestStore,
} from '@openmaic/storage';

import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { AppScene } from '@/lib/types/stage';
import type { Queryable } from '@openmaic/storage/document/pg';

/**
 * The owner-bound document store for one HTTP request, plus the
 * trigger-maintained freshness manifest read the PG backend provides.
 */
export type OwnerScopedDocumentStore = DocumentStore<AppScene, AppStage> &
  DocumentFolderStore &
  StageFreshnessManifestStore;

/**
 * The owner-bound document store for one HTTP request.
 *
 * This is the exact seam the agent runner uses (`runner.ts`): the document
 * provider is bound to the resolved owner through the stage access layer.
 * Reads are capability-by-id, writes and listings are owner-only, and every
 * operation re-checks `stage_meta` inside its transaction. A browser holding a
 * course id may therefore read it without gaining mutation authority.
 * `withPlainJsonDocumentWrites` keeps the write
 * boundary identical to the agent tools' (undefined-valued members are never
 * persisted as JSON nulls).
 */
export async function getOwnerScopedDocumentStore(
  ownerId: string,
  mutationFence?: (queryable: Queryable) => Promise<void>,
): Promise<OwnerScopedDocumentStore> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return withPlainJsonDocumentWrites(
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence,
    }) as unknown as OwnerScopedDocumentStore,
  );
}
