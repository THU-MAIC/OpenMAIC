import type { PPTElement, RuntimeRecord, Whiteboard } from '@openmaic/dsl';

export const WHITEBOARD_RUNTIME_KIND = 'whiteboard';
export const WHITEBOARD_RUNTIME_PAYLOAD_VERSION = 1;
export const LEGACY_WHITEBOARD_SOURCE_KIND = 'stage.whiteboard';
export const LEGACY_WHITEBOARD_SOURCE_VERSION = 'maic.stage-whiteboard.v1';

export type Sha256Digest = `sha256:${string}`;

export interface LegacySnapshotImportedOperation {
  kind: 'legacy_snapshot_imported';
  source: {
    kind: typeof LEGACY_WHITEBOARD_SOURCE_KIND;
    fingerprint: Sha256Digest;
  };
  whiteboard: Whiteboard;
}

export interface WhiteboardElementAddedOperation {
  kind: 'element_added';
  element: PPTElement;
}

export type WhiteboardRuntimeOperationV1 =
  | LegacySnapshotImportedOperation
  | WhiteboardElementAddedOperation;

export interface WhiteboardRuntimePayloadV1 {
  payloadVersion: typeof WHITEBOARD_RUNTIME_PAYLOAD_VERSION;
  operationId: string;
  operation: WhiteboardRuntimeOperationV1;
}

export interface FoldedWhiteboardRuntimeState {
  sessionId: string | null;
  whiteboard: Whiteboard | null;
  lastSeq: number | null;
}

export interface FoldedWhiteboardRuntimeDetails extends FoldedWhiteboardRuntimeState {
  operations: Readonly<
    Record<
      string,
      Readonly<{
        digest: Sha256Digest;
        seq: number;
      }>
    >
  >;
}

export interface AppendWhiteboardRecordInput {
  stageId: string;
  expectedLastSeq: number | null;
  payload: WhiteboardRuntimePayloadV1;
}

export interface AppendWhiteboardRecordResult {
  committedSeq: number;
  state: FoldedWhiteboardRuntimeState;
  replayed: boolean;
}

export type WhiteboardRuntimeRecord = RuntimeRecord<WhiteboardRuntimePayloadV1>;
