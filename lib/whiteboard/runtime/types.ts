import type { CodeLine, PPTElement, RuntimeRecord, Whiteboard } from '@openmaic/dsl';

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

export interface WhiteboardElementDeletedOperation {
  kind: 'element_deleted';
  elementId: string;
}

export interface WhiteboardElementsClearedOperation {
  kind: 'elements_cleared';
}

export type WhiteboardCodeLinesEdit =
  | {
      kind: 'insert_after' | 'insert_before';
      lineId: string;
      lines: CodeLine[];
    }
  | {
      kind: 'delete_lines';
      lineIds: string[];
    }
  | {
      kind: 'replace_lines';
      lineIds: string[];
      lines: CodeLine[];
    };

export interface WhiteboardCodeLinesEditedOperation {
  kind: 'code_lines_edited';
  elementId: string;
  edit: WhiteboardCodeLinesEdit;
}

export type WhiteboardRuntimeOperationV1 =
  | LegacySnapshotImportedOperation
  | WhiteboardElementAddedOperation
  | WhiteboardElementDeletedOperation
  | WhiteboardElementsClearedOperation
  | WhiteboardCodeLinesEditedOperation;

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

export class WhiteboardRuntimeElementNotFoundError extends Error {
  override readonly name = 'WhiteboardRuntimeElementNotFoundError';
  readonly code = 'WHITEBOARD_RUNTIME_ELEMENT_NOT_FOUND';

  constructor(readonly elementId: string) {
    super(`Whiteboard element ${JSON.stringify(elementId)} was not found`);
  }
}

export class WhiteboardRuntimeElementTypeMismatchError extends Error {
  override readonly name = 'WhiteboardRuntimeElementTypeMismatchError';
  readonly code = 'WHITEBOARD_RUNTIME_ELEMENT_TYPE_MISMATCH';
  readonly expectedType = 'code';

  constructor(
    readonly elementId: string,
    readonly actualType: PPTElement['type'],
  ) {
    super(
      `Whiteboard element ${JSON.stringify(elementId)} has type ${JSON.stringify(actualType)}; expected code`,
    );
  }
}

export class WhiteboardRuntimeCodeLineNotFoundError extends Error {
  override readonly name = 'WhiteboardRuntimeCodeLineNotFoundError';
  readonly code = 'WHITEBOARD_RUNTIME_CODE_LINE_NOT_FOUND';

  constructor(
    readonly elementId: string,
    readonly lineId: string,
  ) {
    super(
      `Code line ${JSON.stringify(lineId)} was not found in whiteboard element ${JSON.stringify(elementId)}`,
    );
  }
}

export class WhiteboardRuntimeCodeLineIdConflictError extends Error {
  override readonly name = 'WhiteboardRuntimeCodeLineIdConflictError';
  readonly code = 'WHITEBOARD_RUNTIME_CODE_LINE_ID_CONFLICT';

  constructor(
    readonly elementId: string,
    readonly lineId: string,
  ) {
    super(
      `Code line ID ${JSON.stringify(lineId)} conflicts in whiteboard element ${JSON.stringify(elementId)}`,
    );
  }
}

export type WhiteboardRuntimeNoChangeReason = 'whiteboard_missing' | 'whiteboard_empty';

export class WhiteboardRuntimeNoChangeError extends Error {
  override readonly name = 'WhiteboardRuntimeNoChangeError';
  readonly code = 'WHITEBOARD_RUNTIME_NO_CHANGE';

  constructor(
    readonly reason: WhiteboardRuntimeNoChangeReason,
    readonly state?: FoldedWhiteboardRuntimeState,
  ) {
    super(`Whiteboard mutation made no change: ${reason}`);
  }
}

export type WhiteboardRuntimeRecord = RuntimeRecord<WhiteboardRuntimePayloadV1>;
