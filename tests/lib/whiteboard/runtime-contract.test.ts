import type { RuntimeRecord, Whiteboard } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import { foldWhiteboardRuntimeRecords } from '@/lib/whiteboard/runtime/fold';
import {
  LEGACY_WHITEBOARD_SOURCE_KIND,
  WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
  type WhiteboardRuntimePayloadV1,
} from '@/lib/whiteboard/runtime/types';
import {
  cloneCanonicalJson,
  normalizeAndValidateLegacyWhiteboard,
  sha256Canonical,
  validateWhiteboardRuntimePayload,
} from '@/lib/whiteboard/runtime/validate';

function board(overrides: Partial<Whiteboard> = {}): Whiteboard {
  return {
    id: 'board-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements: [
      {
        id: 'text-1',
        type: 'text',
        left: 10,
        top: 20,
        width: 300,
        height: 60,
        rotate: 0,
        content: 'hello',
        defaultFontName: 'Inter',
        defaultColor: '#000000',
      },
    ],
    ...overrides,
  };
}

function payload(overrides: Partial<WhiteboardRuntimePayloadV1> = {}): WhiteboardRuntimePayloadV1 {
  return {
    payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
    operationId: 'legacy-import:one',
    operation: {
      kind: 'legacy_snapshot_imported',
      source: {
        kind: LEGACY_WHITEBOARD_SOURCE_KIND,
        fingerprint: `sha256:${'0'.repeat(64)}`,
      },
      whiteboard: board(),
    },
    ...overrides,
  };
}

function record(seq: number, value = payload()): RuntimeRecord {
  return {
    id: value.operationId,
    sessionId: 'session-1',
    seq,
    createdAt: '2026-08-06T00:00:00.000Z',
    payload: value,
  };
}

describe('whiteboard RuntimeStore payload contract', () => {
  it('accepts a canonical exact-key import payload', () => {
    expect(validateWhiteboardRuntimePayload(payload())).toEqual({ valid: true });
  });

  it.each([
    ['extra payload key', { ...payload(), extra: true }],
    ['unknown payload version', { ...payload(), payloadVersion: 2 }],
    ['unknown operation', { ...payload(), operation: { ...payload().operation, kind: 'draw' } }],
    [
      'duplicate element id',
      {
        ...payload(),
        operation: {
          ...payload().operation,
          whiteboard: board({ elements: [board().elements[0]!, board().elements[0]!] }),
        },
      },
    ],
    [
      'non-finite geometry',
      {
        ...payload(),
        operation: {
          ...payload().operation,
          whiteboard: board({
            elements: [{ ...board().elements[0]!, left: Number.POSITIVE_INFINITY }],
          }),
        },
      },
    ],
    [
      'unknown element kind',
      {
        ...payload(),
        operation: {
          ...payload().operation,
          whiteboard: board({
            elements: [{ ...board().elements[0]!, type: 'unknown' } as never],
          }),
        },
      },
    ],
    [
      'non-canonical element',
      {
        ...payload(),
        operation: {
          ...payload().operation,
          whiteboard: board({
            elements: [
              {
                id: 'text-raw',
                type: 'text',
                left: 0,
                top: 0,
                width: 100,
                height: 40,
                rotate: 0,
              } as never,
            ],
          }),
        },
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(validateWhiteboardRuntimePayload(value).valid).toBe(false);
  });

  it('normalizes a valid Legacy element before persistence', () => {
    const raw = board({
      elements: [
        {
          id: 'text-raw',
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
        } as never,
      ],
    });
    const normalized = normalizeAndValidateLegacyWhiteboard(raw);
    expect(normalized.elements[0]).toMatchObject({
      content: '',
      defaultFontName: 'Microsoft YaHei',
      defaultColor: '#333333',
    });
  });

  it('accepts generated-schema tuple constraints for a normalized shape', () => {
    const normalized = normalizeAndValidateLegacyWhiteboard(
      board({
        elements: [
          {
            id: 'shape-1',
            type: 'shape',
            left: 0,
            top: 0,
            width: 100,
            height: 80,
            rotate: 0,
          } as never,
        ],
      }),
    );
    expect(normalized.elements[0]).toMatchObject({
      type: 'shape',
      viewBox: [100, 80],
    });
  });

  it('rejects non-JSON containers, sparse arrays, cycles, undefined, and unsafe strings', () => {
    const dateValue = payload();
    dateValue.operation.whiteboard.background = new Date() as never;
    expect(validateWhiteboardRuntimePayload(dateValue).valid).toBe(false);

    const sparseValue = payload();
    const sparse = new Array(1) as Whiteboard['elements'];
    sparseValue.operation.whiteboard.elements = sparse;
    expect(validateWhiteboardRuntimePayload(sparseValue).valid).toBe(false);

    const cyclicValue = payload();
    (cyclicValue.operation.whiteboard as unknown as Record<string, unknown>).script = cyclicValue;
    expect(validateWhiteboardRuntimePayload(cyclicValue).valid).toBe(false);

    const undefinedValue = payload();
    (undefinedValue.operation.whiteboard as unknown as Record<string, unknown>).script = undefined;
    expect(validateWhiteboardRuntimePayload(undefinedValue).valid).toBe(false);

    expect(validateWhiteboardRuntimePayload(payload({ operationId: 'unsafe\u0000id' })).valid).toBe(
      false,
    );
    expect(
      validateWhiteboardRuntimePayload(
        payload({ operationId: `unsafe${String.fromCharCode(0xd800)}` }),
      ).valid,
    ).toBe(false);
  });

  it('canonicalizes key order and detaches caller aliases', async () => {
    const source = payload();
    const copy = cloneCanonicalJson(source);
    const before = await sha256Canonical(copy);
    source.operation.whiteboard.elements[0]!.id = 'mutated';
    expect(copy.operation.whiteboard.elements[0]!.id).toBe('text-1');
    expect(await sha256Canonical(copy)).toBe(before);
    expect(await sha256Canonical({ b: 2, a: 1 })).toBe(await sha256Canonical({ a: 1, b: 2 }));
  });
});

describe('whiteboard RuntimeStore fold', () => {
  it('folds an empty session shell without inventing state', async () => {
    await expect(foldWhiteboardRuntimeRecords('session-1', [])).resolves.toMatchObject({
      sessionId: 'session-1',
      whiteboard: null,
      lastSeq: null,
    });
  });

  it('applies an exact duplicate operation once while retaining the real tail', async () => {
    const result = await foldWhiteboardRuntimeRecords('session-1', [record(0), record(1)]);
    expect(result.whiteboard?.id).toBe('board-1');
    expect(result.lastSeq).toBe(1);
    expect(Object.keys(result.operations)).toEqual(['legacy-import:one']);
    expect(Object.isFrozen(result.whiteboard)).toBe(true);
    expect(Object.isFrozen(result.operations)).toBe(true);
  });

  it('fails closed on conflicting duplicate, sequence, and session identity', async () => {
    const conflicting = payload({
      operation: { ...payload().operation, whiteboard: board({ id: 'board-2' }) },
    });
    await expect(
      foldWhiteboardRuntimeRecords('session-1', [record(0), record(1, conflicting)]),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_OPERATION_CONFLICT');
    await expect(foldWhiteboardRuntimeRecords('session-1', [record(1)])).rejects.toThrow(
      'WHITEBOARD_RUNTIME_RECORD_SEQUENCE_INVALID',
    );
    await expect(foldWhiteboardRuntimeRecords('other-session', [record(0)])).rejects.toThrow(
      'WHITEBOARD_RUNTIME_RECORD_SESSION_MISMATCH',
    );
    await expect(
      foldWhiteboardRuntimeRecords('session-1', [{ ...record(0), id: 'wrong-record-id' }]),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_RECORD_OPERATION_ID_MISMATCH');
  });

  it('fails closed on malformed record envelopes and whiteboard-forbidden anchors', async () => {
    await expect(
      foldWhiteboardRuntimeRecords('session-1', [
        { ...record(0), createdAt: 'not-an-iso-timestamp' },
      ]),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_RECORD_ENVELOPE_INVALID');

    for (const anchored of [
      { ...record(0), sceneId: 'scene-1' },
      { ...record(0), actionIndex: 0 },
      { ...record(0), subAnchor: 'question-1' },
    ]) {
      await expect(foldWhiteboardRuntimeRecords('session-1', [anchored])).rejects.toThrow(
        'WHITEBOARD_RUNTIME_RECORD_ANCHOR_INVALID',
      );
    }
  });
});
