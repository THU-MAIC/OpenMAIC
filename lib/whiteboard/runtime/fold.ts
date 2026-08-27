import {
  validateRuntimeRecord,
  type CodeLine,
  type RuntimeRecord,
  type Whiteboard,
} from '@openmaic/dsl';

import {
  WhiteboardRuntimeCodeLineIdConflictError,
  WhiteboardRuntimeCodeLineNotFoundError,
  WhiteboardRuntimeElementNotFoundError,
  WhiteboardRuntimeElementTypeMismatchError,
  WhiteboardRuntimeNoChangeError,
  type FoldedWhiteboardRuntimeDetails,
  type FoldedWhiteboardRuntimeState,
  type Sha256Digest,
  type WhiteboardRuntimeOperationV1,
  type WhiteboardRuntimePayloadV1,
} from './types';
import {
  assertWhiteboardRuntimePayload,
  canonicalJson,
  cloneCanonicalJson,
  normalizeAndValidateWhiteboardElement,
  sha256Canonical,
} from './validate';

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

const RUNTIME_WHITEBOARD_ID_NAMESPACE = 'openmaic.whiteboard-runtime-board.v1';

async function deriveRuntimeWhiteboardId(sessionId: string): Promise<string> {
  const digest = await sha256Canonical({
    namespace: RUNTIME_WHITEBOARD_ID_NAMESPACE,
    sessionId,
  });
  return `runtime-whiteboard:${digest.slice('sha256:'.length)}`;
}

export async function applyWhiteboardRuntimeOperation(
  sessionId: string,
  current: Whiteboard | null,
  operation: WhiteboardRuntimeOperationV1,
): Promise<Whiteboard> {
  const snapshot = immutableClone(operation);
  if (snapshot.kind === 'legacy_snapshot_imported') {
    if (current !== null) throw new Error('WHITEBOARD_RUNTIME_IMPORT_AFTER_STATE');
    return immutableClone(snapshot.whiteboard);
  }

  if (snapshot.kind === 'element_added') {
    if (current?.elements.some((element) => element.id === snapshot.element.id)) {
      throw new Error('WHITEBOARD_RUNTIME_ELEMENT_ALREADY_EXISTS');
    }
    if (current === null) {
      return immutableClone({
        id: await deriveRuntimeWhiteboardId(sessionId),
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [snapshot.element],
        background: { type: 'solid', color: '#ffffff' },
        animations: [],
      });
    }
    return immutableClone({
      ...current,
      elements: [...current.elements, snapshot.element],
    });
  }

  if (snapshot.kind === 'elements_cleared') {
    if (current === null) throw new WhiteboardRuntimeNoChangeError('whiteboard_missing');
    if (current.elements.length === 0) {
      throw new WhiteboardRuntimeNoChangeError('whiteboard_empty');
    }
    return immutableClone({ ...current, elements: [] });
  }

  if (current === null) {
    throw new WhiteboardRuntimeElementNotFoundError(snapshot.elementId);
  }
  const elementIndex = current.elements.findIndex((element) => element.id === snapshot.elementId);
  if (elementIndex === -1) {
    throw new WhiteboardRuntimeElementNotFoundError(snapshot.elementId);
  }

  if (snapshot.kind === 'element_deleted') {
    return immutableClone({
      ...current,
      elements: current.elements.filter((_element, index) => index !== elementIndex),
    });
  }

  const element = current.elements[elementIndex]!;
  if (element.type !== 'code') {
    throw new WhiteboardRuntimeElementTypeMismatchError(snapshot.elementId, element.type);
  }
  const lines = [...element.lines];
  const edit = snapshot.edit;
  const targetLineIds = 'lineId' in edit ? [edit.lineId] : edit.lineIds;
  const knownLineIds = new Set(lines.map((line) => line.id));
  const missingLineId = targetLineIds.find((lineId) => !knownLineIds.has(lineId));
  if (missingLineId !== undefined) {
    throw new WhiteboardRuntimeCodeLineNotFoundError(snapshot.elementId, missingLineId);
  }

  const assertIntroducedLineIdsDoNotConflict = (
    retainedLines: readonly CodeLine[],
    introducedLines: readonly CodeLine[],
  ): void => {
    const retainedIds = new Set(retainedLines.map((line) => line.id));
    const introducedIds = new Set<string>();
    for (const line of introducedLines) {
      if (retainedIds.has(line.id) || introducedIds.has(line.id)) {
        throw new WhiteboardRuntimeCodeLineIdConflictError(snapshot.elementId, line.id);
      }
      introducedIds.add(line.id);
    }
  };

  let editedLines: CodeLine[];
  if ('lineId' in edit) {
    assertIntroducedLineIdsDoNotConflict(lines, edit.lines);
    editedLines = [...lines];
    const referenceIndex = editedLines.findIndex((line) => line.id === edit.lineId);
    editedLines.splice(
      edit.kind === 'insert_after' ? referenceIndex + 1 : referenceIndex,
      0,
      ...edit.lines,
    );
  } else if (edit.kind === 'delete_lines') {
    const deleted = new Set(edit.lineIds);
    editedLines = lines.filter((line) => !deleted.has(line.id));
  } else {
    // Match the Legacy transition: anchor replacement at the first supplied target ID,
    // remove all targets, then insert the host-supplied replacement lines exactly.
    const firstIndex = lines.findIndex((line) => line.id === edit.lineIds[0]);
    const replaced = new Set(edit.lineIds);
    editedLines = lines.filter((line) => !replaced.has(line.id));
    assertIntroducedLineIdsDoNotConflict(editedLines, edit.lines);
    editedLines.splice(firstIndex, 0, ...edit.lines);
  }
  const editedElement = { ...element, lines: editedLines };
  const normalizedElement = normalizeAndValidateWhiteboardElement(editedElement);
  if (canonicalJson(normalizedElement) !== canonicalJson(editedElement)) {
    throw new Error('WHITEBOARD_RUNTIME_CODE_ELEMENT_NOT_CANONICAL');
  }
  const elements = [...current.elements];
  elements[elementIndex] = editedElement;
  return immutableClone({ ...current, elements });
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
    whiteboard = await applyWhiteboardRuntimeOperation(sessionId, whiteboard, payload.operation);
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
