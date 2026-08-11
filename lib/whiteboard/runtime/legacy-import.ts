import type { MaicDocument } from '@openmaic/storage';
import type { Whiteboard } from '@openmaic/dsl';

import { isDocumentStorageConfigured } from '@/lib/document-store/config';
import { withDocumentLock } from '@/lib/document-store/migration';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { getDocumentStore } from '@/lib/document-store/store';
import { isRuntimeStorageConfigured } from '@/lib/runtime/config';
import type { AppScene } from '@/lib/types/stage';

import { type WhiteboardRuntimeService, getWhiteboardRuntimeService } from './store';
import {
  LEGACY_WHITEBOARD_SOURCE_KIND,
  LEGACY_WHITEBOARD_SOURCE_VERSION,
  WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
  type WhiteboardRuntimePayloadV1,
} from './types';
import { normalizeAndValidateLegacyWhiteboard, sha256Canonical } from './validate';

export type LegacyWhiteboardImportResult =
  | { status: 'imported'; replayed: boolean; committedSeq: number }
  | {
      status: 'not_imported';
      reason:
        | 'runtime_authoritative'
        | 'provenance_ineligible'
        | 'document_missing'
        | 'legacy_missing'
        | 'legacy_ambiguous'
        | 'legacy_malformed'
        | 'runtime_won';
    }
  | { status: 'uncertain'; reason: 'document_read_failed' | 'append_failed' };

export interface LegacyWhiteboardImporterDeps {
  service: WhiteboardRuntimeService;
  provenanceEligible: () => boolean;
  loadDocument: (stageId: string) => Promise<MaicDocument<AppScene, AppStage> | null>;
  withDocumentLock: <T>(stageId: string, work: () => Promise<T>) => Promise<T>;
}

/** @internal Sealed configuration-derived provenance predicate. */
export function isLegacyWhiteboardAutoImportEligible(): boolean {
  return (
    process.env.NEXT_PUBLIC_PERSISTENCE !== '1' &&
    !isDocumentStorageConfigured() &&
    !isRuntimeStorageConfigured()
  );
}

function createLegacyWhiteboardImporter(deps: LegacyWhiteboardImporterDeps) {
  return async (stageId: string): Promise<LegacyWhiteboardImportResult> => {
    const current = await deps.service.read(stageId);
    if (current.lastSeq !== null) {
      return { status: 'not_imported', reason: 'runtime_authoritative' };
    }
    if (!deps.provenanceEligible()) {
      return { status: 'not_imported', reason: 'provenance_ineligible' };
    }

    return deps.withDocumentLock(stageId, async () => {
      const afterLock = await deps.service.read(stageId);
      if (afterLock.lastSeq !== null) {
        return { status: 'not_imported', reason: 'runtime_authoritative' };
      }

      let document: MaicDocument<AppScene, AppStage> | null;
      try {
        document = await deps.loadDocument(stageId);
      } catch {
        return { status: 'uncertain', reason: 'document_read_failed' };
      }
      if (!document) return { status: 'not_imported', reason: 'document_missing' };
      const candidates = document.stage.whiteboard ?? [];
      if (candidates.length === 0) return { status: 'not_imported', reason: 'legacy_missing' };
      if (candidates.length !== 1) return { status: 'not_imported', reason: 'legacy_ambiguous' };

      let whiteboard: Whiteboard;
      try {
        whiteboard = normalizeAndValidateLegacyWhiteboard(candidates[0]);
      } catch {
        return { status: 'not_imported', reason: 'legacy_malformed' };
      }
      const fingerprint = await sha256Canonical({
        sourceVersion: LEGACY_WHITEBOARD_SOURCE_VERSION,
        stageId,
        whiteboard,
      });
      const payload: WhiteboardRuntimePayloadV1 = {
        payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
        operationId: `legacy-import:${fingerprint.slice('sha256:'.length)}`,
        operation: {
          kind: 'legacy_snapshot_imported',
          source: { kind: LEGACY_WHITEBOARD_SOURCE_KIND, fingerprint },
          whiteboard,
        },
      };

      try {
        const result = await deps.service.append({ stageId, expectedLastSeq: null, payload });
        return {
          status: 'imported',
          replayed: result.replayed,
          committedSeq: result.committedSeq,
        };
      } catch {
        const reconciliation = await deps.service
          .reconcileOperation(stageId, payload)
          .catch(() => null);
        if (reconciliation?.status === 'exact') {
          return {
            status: 'imported',
            replayed: true,
            committedSeq: reconciliation.committedSeq,
          };
        }
        if (reconciliation?.status === 'other') {
          return { status: 'not_imported', reason: 'runtime_won' };
        }
        return { status: 'uncertain', reason: 'append_failed' };
      }
    });
  };
}

/**
 * Dormant PR1 compatibility seam. No production load/tool path calls it until
 * the later writer cutover proves there is no Stage.whiteboard dual authority.
 */
export function importEligibleLegacyWhiteboard(
  stageId: string,
): Promise<LegacyWhiteboardImportResult> {
  return createLegacyWhiteboardImporter({
    service: getWhiteboardRuntimeService(),
    provenanceEligible: isLegacyWhiteboardAutoImportEligible,
    loadDocument: (id) => getDocumentStore().loadDocument(id),
    withDocumentLock: (id, work) => withDocumentLock(id, work),
  })(stageId);
}

/** @internal Test construction seam; production provenance remains sealed. */
export function createLegacyWhiteboardImporterForTests(
  deps: Omit<LegacyWhiteboardImporterDeps, 'withDocumentLock'> &
    Partial<Pick<LegacyWhiteboardImporterDeps, 'withDocumentLock'>>,
): (stageId: string) => Promise<LegacyWhiteboardImportResult> {
  return createLegacyWhiteboardImporter({
    ...deps,
    withDocumentLock: deps.withDocumentLock ?? ((_stageId, work) => work()),
  });
}
