import type { Scene, Stage } from '@/lib/types/stage';
import type { StageOutlinesRecord } from '@/lib/utils/database';

/** Increment only when the bridge representation itself changes. */
export const DOCUMENT_BRIDGE_VERSION = 'b2.1';

export type DocumentBridgeStatus = 'in_progress' | 'migrated' | 'failed';

export interface DocumentBridgeLedgerEntry {
  courseId: string;
  status: DocumentBridgeStatus;
  sourceHash: string;
  bridgeVersion: string;
  updatedAt: number;
  /** Only a short category; never persist raw course data or stack traces. */
  errorCode?: string;
}

export interface LegacyDocumentSnapshot {
  stage: Stage;
  scenes: Scene[];
  /** Preserve the complete existing Dexie record, not just its outline array. */
  outlineRecord?: StageOutlinesRecord;
}

export type BridgeOutcome = 'success' | 'failure';

export type BridgeDurationBucket = 'lt_50ms' | 'lt_250ms' | 'lt_1s' | 'gte_1s';

export type BridgeFailureCode =
  | 'validation'
  | 'indexeddb'
  | 'quota'
  | 'identity'
  | 'unknown';
