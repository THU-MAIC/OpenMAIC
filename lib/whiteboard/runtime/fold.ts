import { validateRuntimeRecord, type RuntimeRecord } from '@openmaic/dsl';

import {
  type FoldedWhiteboardRuntimeDetails,
  type FoldedWhiteboardRuntimeState,
  type Sha256Digest,
  type WhiteboardRuntimePayloadV1,
} from './types';
import { assertWhiteboardRuntimePayload, cloneCanonicalJson, sha256Canonical } from './validate';

function immutableClone<T>(value: T): T {
  const cloned = cloneCanonicalJson(value);
  const freeze = (input: unknown): void => {
    if (typeof input !== 'object' || input === null || Object.isFrozen(input)) return;
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  };
  freeze(cloned);
  return cloned;
}

export async function foldWhiteboardRuntimeRecords(
  sessionId: string,
  records: readonly RuntimeRecord[],
): Promise<FoldedWhiteboardRuntimeDetails> {
  let whiteboard: FoldedWhiteboardRuntimeState['whiteboard'] = null;
  const operations: Record<string, Readonly<{ digest: Sha256Digest; seq: number }>> = Object.create(
    null,
  ) as Record<string, Readonly<{ digest: Sha256Digest; seq: number }>>;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!validateRuntimeRecord(record).valid) {
      throw new Error('WHITEBOARD_RUNTIME_RECORD_ENVELOPE_INVALID');
    }
    if (
      Object.hasOwn(record, 'sceneId') ||
      Object.hasOwn(record, 'actionIndex') ||
      Object.hasOwn(record, 'subAnchor')
    ) {
      throw new Error('WHITEBOARD_RUNTIME_RECORD_ANCHOR_INVALID');
    }
    if (record.sessionId !== sessionId) {
      throw new Error('WHITEBOARD_RUNTIME_RECORD_SESSION_MISMATCH');
    }
    if (record.seq !== index) throw new Error('WHITEBOARD_RUNTIME_RECORD_SEQUENCE_INVALID');
    assertWhiteboardRuntimePayload(record.payload);
    const payload = immutableClone(record.payload as WhiteboardRuntimePayloadV1);
    if (record.id !== payload.operationId) {
      throw new Error('WHITEBOARD_RUNTIME_RECORD_OPERATION_ID_MISMATCH');
    }
    const digest = await sha256Canonical(payload);
    const previous = operations[payload.operationId];
    if (previous) {
      if (previous.digest !== digest) throw new Error('WHITEBOARD_RUNTIME_OPERATION_CONFLICT');
      continue;
    }
    operations[payload.operationId] = Object.freeze({ digest, seq: record.seq });
    if (payload.operation.kind === 'legacy_snapshot_imported') {
      if (whiteboard !== null) throw new Error('WHITEBOARD_RUNTIME_IMPORT_AFTER_STATE');
      whiteboard = immutableClone(payload.operation.whiteboard);
    }
  }

  return Object.freeze({
    sessionId,
    whiteboard,
    lastSeq: records.at(-1)?.seq ?? null,
    operations: Object.freeze(operations),
  });
}

export function publicWhiteboardRuntimeState(
  details: FoldedWhiteboardRuntimeDetails,
): FoldedWhiteboardRuntimeState {
  return Object.freeze({
    sessionId: details.sessionId,
    whiteboard: details.whiteboard,
    lastSeq: details.lastSeq,
  });
}

export const EMPTY_WHITEBOARD_RUNTIME_STATE: FoldedWhiteboardRuntimeState = Object.freeze({
  sessionId: null,
  whiteboard: null,
  lastSeq: null,
});
