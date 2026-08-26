import type { PPTElement, RuntimeRecord, Whiteboard } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import { foldWhiteboardRuntimeRecords } from '@/lib/whiteboard/runtime/fold';
import {
  LEGACY_WHITEBOARD_SOURCE_KIND,
  WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
  type LegacySnapshotImportedOperation,
  type WhiteboardElementAddedOperation,
  type WhiteboardRuntimeOperationV1,
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

type LegacyPayload = WhiteboardRuntimePayloadV1 & {
  operation: LegacySnapshotImportedOperation;
};

type ElementAddedPayload = WhiteboardRuntimePayloadV1 & {
  operation: WhiteboardElementAddedOperation;
};

function textElement(id = 'text-added', content = 'learner text'): PPTElement {
  return {
    id,
    type: 'text',
    left: 40,
    top: 50,
    width: 240,
    height: 60,
    rotate: 0,
    content,
    defaultFontName: 'Inter',
    defaultColor: '#000000',
  };
}

function codeElement(
  id = 'code-1',
  lines = [
    { id: 'L1', content: 'const one = 1;' },
    { id: 'L2', content: 'const two = 2;' },
    { id: 'L3', content: 'return one + two;' },
    { id: 'L4', content: '' },
  ],
): PPTElement {
  return {
    id,
    type: 'code',
    language: 'typescript',
    lines,
    fileName: 'example.ts',
    showLineNumbers: true,
    fontSize: 14,
    left: 100,
    top: 120,
    width: 500,
    height: 300,
    rotate: 0,
  };
}

function payload(overrides: Partial<LegacyPayload> = {}): LegacyPayload {
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

function elementPayload(
  operationId = 'element-add:one',
  element = textElement(),
): ElementAddedPayload {
  return {
    payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
    operationId,
    operation: { kind: 'element_added', element },
  };
}

function operationPayload(
  operationId: string,
  operation: WhiteboardRuntimeOperationV1,
): WhiteboardRuntimePayloadV1 {
  return { payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION, operationId, operation };
}

function record(seq: number, value: WhiteboardRuntimePayloadV1 = payload()): RuntimeRecord {
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

  it('accepts only the canonical tool-agnostic element_added shape', () => {
    expect(validateWhiteboardRuntimePayload(elementPayload())).toEqual({ valid: true });
    expect(
      validateWhiteboardRuntimePayload({
        ...elementPayload(),
        operation: { ...elementPayload().operation, whiteboardId: 'model-selected-board' },
      }).valid,
    ).toBe(false);
    expect(
      validateWhiteboardRuntimePayload({
        ...elementPayload(),
        operation: {
          kind: 'element_added',
          element: { ...textElement(), content: undefined },
        },
      }).valid,
    ).toBe(false);
    expect(
      validateWhiteboardRuntimePayload({
        ...elementPayload(),
        operation: {
          kind: 'element_added',
          element: {
            id: 'text-raw',
            type: 'text',
            left: 0,
            top: 0,
            width: 100,
            height: 40,
            rotate: 0,
          },
        },
      }).valid,
    ).toBe(false);
  });

  it('does not narrow the frozen code-line contract for existing add/import operations', () => {
    const legacyCode = codeElement('legacy-code', [
      { id: '', content: 'first' },
      { id: '', content: 'second' },
    ]);
    expect(
      validateWhiteboardRuntimePayload(elementPayload('element-add:legacy-code', legacyCode)),
    ).toEqual({ valid: true });
    expect(
      validateWhiteboardRuntimePayload(
        payload({
          operation: {
            ...payload().operation,
            whiteboard: board({ elements: [legacyCode] }),
          },
        }),
      ),
    ).toEqual({ valid: true });
  });

  it('accepts only exact destructive and line-edit operation shapes', () => {
    for (const candidate of [
      operationPayload('delete:one', { kind: 'element_deleted', elementId: 'text-1' }),
      operationPayload('clear:one', { kind: 'elements_cleared' }),
      operationPayload('edit:after', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'insert_after', lineId: 'L1', lines: [{ id: 'L1.5', content: '' }] },
      }),
      operationPayload('edit:before', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'insert_before', lineId: 'L2', lines: [{ id: 'L1.9', content: ' ' }] },
      }),
      operationPayload('edit:delete', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'delete_lines', lineIds: ['L1', 'L3'] },
      }),
      operationPayload('edit:replace', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: {
          kind: 'replace_lines',
          lineIds: ['L3', 'L1'],
          lines: [
            { id: 'host-1', content: '' },
            { id: 'host-2', content: 'replacement' },
          ],
        },
      }),
      operationPayload('edit:legacy-empty-insert-target', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'insert_after', lineId: '', lines: [{ id: 'host-empty-1', content: '' }] },
      }),
      operationPayload('edit:legacy-empty-delete-target', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'delete_lines', lineIds: [''] },
      }),
      operationPayload('edit:legacy-empty-replace-target', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: {
          kind: 'replace_lines',
          lineIds: [''],
          lines: [{ id: 'host-empty-2', content: 'replacement' }],
        },
      }),
    ]) {
      expect(validateWhiteboardRuntimePayload(candidate)).toEqual({ valid: true });
    }

    for (const candidate of [
      operationPayload('delete:extra', {
        kind: 'element_deleted',
        elementId: 'text-1',
        whiteboard: board(),
      } as never),
      operationPayload('clear:extra', { kind: 'elements_cleared', elementId: 'text-1' } as never),
      operationPayload('edit:empty-targets', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'delete_lines', lineIds: [] },
      }),
      operationPayload('edit:duplicate-targets', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'delete_lines', lineIds: ['L1', 'L1'] },
      }),
      operationPayload('edit:empty-lines', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'insert_after', lineId: 'L1', lines: [] },
      }),
      operationPayload('edit:duplicate-lines', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: {
          kind: 'replace_lines',
          lineIds: ['L1'],
          lines: [
            { id: 'new', content: 'one' },
            { id: 'new', content: 'two' },
          ],
        },
      }),
      operationPayload('edit:extra-line-key', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: {
          kind: 'insert_before',
          lineId: 'L1',
          lines: [{ id: 'new', content: 'one', extra: true } as never],
        },
      }),
      operationPayload('edit:unsafe-line', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'delete_lines', lineIds: ['unsafe\u0000line'] },
      }),
      operationPayload('edit:unsafe-new-line', {
        kind: 'code_lines_edited',
        elementId: 'code-1',
        edit: { kind: 'insert_after', lineId: 'L1', lines: [{ id: '', content: 'new' }] },
      }),
    ]) {
      expect(validateWhiteboardRuntimePayload(candidate).valid).toBe(false);
    }
  });

  it('rejects non-enumerable line and target array entries instead of laundering them', () => {
    const hiddenLines = [{ id: 'host-line', content: 'new' }];
    Object.defineProperty(hiddenLines, '0', {
      value: hiddenLines[0],
      enumerable: false,
      writable: true,
      configurable: true,
    });
    expect(
      validateWhiteboardRuntimePayload(
        operationPayload('edit:hidden-lines', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: { kind: 'insert_after', lineId: 'L1', lines: hiddenLines },
        }),
      ).valid,
    ).toBe(false);

    const hiddenLineIds = ['L1'];
    Object.defineProperty(hiddenLineIds, '0', {
      value: hiddenLineIds[0],
      enumerable: false,
      writable: true,
      configurable: true,
    });
    expect(
      validateWhiteboardRuntimePayload(
        operationPayload('edit:hidden-targets', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: { kind: 'delete_lines', lineIds: hiddenLineIds },
        }),
      ).valid,
    ).toBe(false);
  });

  it('rejects inherited and symbol-key line edit fields', () => {
    const inheritedEdit = Object.create({ kind: 'delete_lines', lineIds: ['L1'] });
    expect(
      validateWhiteboardRuntimePayload({
        ...operationPayload('edit:inherited', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: { kind: 'delete_lines', lineIds: ['L1'] },
        }),
        operation: { kind: 'code_lines_edited', elementId: 'code-1', edit: inheritedEdit },
      }).valid,
    ).toBe(false);

    const symbolEdit = { kind: 'delete_lines', lineIds: ['L1'] };
    Object.defineProperty(symbolEdit, Symbol('hidden'), { value: true, enumerable: true });
    expect(
      validateWhiteboardRuntimePayload({
        ...operationPayload('edit:symbol', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: { kind: 'delete_lines', lineIds: ['L1'] },
        }),
        operation: { kind: 'code_lines_edited', elementId: 'code-1', edit: symbolEdit },
      }).valid,
    ).toBe(false);
  });

  it('requires contract fields to be own properties', () => {
    const validateWithInheritedFields = (
      inherited: Readonly<Record<string, unknown>>,
      candidate: unknown,
    ) => {
      const previous = new Map(
        Object.keys(inherited).map((key) => [
          key,
          Object.getOwnPropertyDescriptor(Object.prototype, key),
        ]),
      );
      try {
        for (const [key, value] of Object.entries(inherited)) {
          Object.defineProperty(Object.prototype, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return validateWhiteboardRuntimePayload(candidate);
      } finally {
        for (const [key, descriptor] of previous) {
          if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
          else delete (Object.prototype as Record<string, unknown>)[key];
        }
      }
    };

    expect(
      validateWithInheritedFields(
        {
          payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
          operationId: 'inherited-operation',
          operation: elementPayload().operation,
        },
        {},
      ).valid,
    ).toBe(false);
    expect(
      validateWithInheritedFields(
        { kind: 'element_added', element: textElement() },
        { ...elementPayload(), operation: {} },
      ).valid,
    ).toBe(false);
    expect(
      validateWithInheritedFields(
        { kind: LEGACY_WHITEBOARD_SOURCE_KIND, fingerprint: `sha256:${'0'.repeat(64)}` },
        { ...payload(), operation: { ...payload().operation, source: {} } },
      ).valid,
    ).toBe(false);
    expect(
      validateWithInheritedFields(
        { id: 'inherited-board', viewportSize: 1000, viewportRatio: 0.5625, elements: [] },
        { ...payload(), operation: { ...payload().operation, whiteboard: {} } },
      ).valid,
    ).toBe(false);
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

  it('preserves own __proto__ keys as plain data during canonical cloning', () => {
    const source = JSON.parse(
      '{"nested":{"safe":true,"__proto__":0},"__proto__":"root"}',
    ) as Record<string, unknown>;
    const copy = cloneCanonicalJson(source);
    const nested = copy.nested as Record<string, unknown>;

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value).toBe('root');
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(nested, '__proto__')?.value).toBe(0);
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

  it('materializes and extends one deterministic session-owned learner board', async () => {
    const sessionId = 'whiteboard:stage-1:private-learner';
    const first = { ...record(0, elementPayload()), sessionId };
    const second = {
      ...record(1, elementPayload('element-add:two', textElement('text-2', 'second'))),
      sessionId,
    };
    const initial = await foldWhiteboardRuntimeRecords(sessionId, [first]);
    const repeated = await foldWhiteboardRuntimeRecords(sessionId, [first]);
    const otherSessionRecord = { ...first, sessionId: 'whiteboard:stage-1:other-learner' };
    const other = await foldWhiteboardRuntimeRecords(otherSessionRecord.sessionId, [
      otherSessionRecord,
    ]);

    expect(initial.whiteboard).toMatchObject({
      id: expect.stringMatching(/^runtime-whiteboard:[0-9a-f]{64}$/u),
      viewportSize: 1000,
      viewportRatio: 0.5625,
      background: { type: 'solid', color: '#ffffff' },
      animations: [],
      elements: [{ id: 'text-added' }],
    });
    expect(initial.whiteboard?.id).toBe(repeated.whiteboard?.id);
    expect(initial.whiteboard?.id).not.toBe(other.whiteboard?.id);
    expect(initial.whiteboard?.id).not.toContain('private-learner');

    const extended = await foldWhiteboardRuntimeRecords(sessionId, [first, second]);
    expect(extended.whiteboard?.id).toBe(initial.whiteboard?.id);
    expect(extended.whiteboard?.elements.map((element) => element.id)).toEqual([
      'text-added',
      'text-2',
    ]);
    expect(Object.isFrozen(extended.whiteboard?.elements)).toBe(true);
  });

  it('preserves a Legacy board for learner adds and rejects invalid ordering or duplicates', async () => {
    const legacyThenAdd = await foldWhiteboardRuntimeRecords('session-1', [
      record(0, payload()),
      record(1, elementPayload()),
    ]);
    expect(legacyThenAdd.whiteboard?.id).toBe('board-1');
    expect(legacyThenAdd.whiteboard?.elements.map((element) => element.id)).toEqual([
      'text-1',
      'text-added',
    ]);

    await expect(
      foldWhiteboardRuntimeRecords('session-1', [
        record(0, elementPayload()),
        record(1, payload()),
      ]),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_IMPORT_AFTER_STATE');
    await expect(
      foldWhiteboardRuntimeRecords('session-1', [
        record(0, elementPayload()),
        record(1, elementPayload('element-add:two')),
      ]),
    ).rejects.toThrow('WHITEBOARD_RUNTIME_ELEMENT_ALREADY_EXISTS');
  });

  it('deletes one element and clears all elements without changing board metadata', async () => {
    const imported = payload({
      operation: {
        ...payload().operation,
        whiteboard: board({
          elements: [textElement('text-1'), codeElement()],
          background: { type: 'solid', color: '#123456' },
          script: 'preserve me',
        }),
      },
    });
    const deleted = await foldWhiteboardRuntimeRecords('session-1', [
      record(0, imported),
      record(1, operationPayload('delete:text', { kind: 'element_deleted', elementId: 'text-1' })),
    ]);
    expect(deleted.whiteboard).toMatchObject({
      id: 'board-1',
      background: { type: 'solid', color: '#123456' },
      script: 'preserve me',
      elements: [{ id: 'code-1' }],
    });

    const cleared = await foldWhiteboardRuntimeRecords('session-1', [
      record(0, imported),
      record(1, operationPayload('clear:all', { kind: 'elements_cleared' })),
    ]);
    expect(cleared.whiteboard).toEqual({ ...imported.operation.whiteboard, elements: [] });
    expect(cleared.whiteboard).not.toBeNull();
  });

  it('matches Legacy line-edit ordering while preserving host replacement IDs and code metadata', async () => {
    const imported = payload({
      operation: {
        ...payload().operation,
        whiteboard: board({ elements: [codeElement()] }),
      },
    });
    const edited = await foldWhiteboardRuntimeRecords('session-1', [
      record(0, imported),
      record(
        1,
        operationPayload('edit:noncontiguous', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: {
            kind: 'replace_lines',
            lineIds: ['L3', 'L1'],
            lines: [
              { id: 'host-A', content: '' },
              { id: 'host-B', content: 'two' },
              { id: 'host-C', content: 'three' },
            ],
          },
        }),
      ),
    ]);
    expect(edited.whiteboard?.elements[0]).toMatchObject({
      id: 'code-1',
      type: 'code',
      language: 'typescript',
      fileName: 'example.ts',
      showLineNumbers: true,
      fontSize: 14,
      lines: [
        { id: 'L2', content: 'const two = 2;' },
        { id: 'L4', content: '' },
        { id: 'host-A', content: '' },
        { id: 'host-B', content: 'two' },
        { id: 'host-C', content: 'three' },
      ],
    });
  });

  it('supports insert-before/after, delete-all, and fewer replacement lines', async () => {
    const imported = payload({
      operation: { ...payload().operation, whiteboard: board({ elements: [codeElement()] }) },
    });
    const result = await foldWhiteboardRuntimeRecords('session-1', [
      record(0, imported),
      record(
        1,
        operationPayload('edit:before', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: { kind: 'insert_before', lineId: 'L2', lines: [{ id: 'B', content: 'before' }] },
        }),
      ),
      record(
        2,
        operationPayload('edit:after', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: { kind: 'insert_after', lineId: 'L2', lines: [{ id: 'A', content: 'after' }] },
        }),
      ),
      record(
        3,
        operationPayload('edit:fewer', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: {
            kind: 'replace_lines',
            lineIds: ['L1', 'L2'],
            lines: [{ id: 'replacement-only', content: '' }],
          },
        }),
      ),
      record(
        4,
        operationPayload('edit:delete-all', {
          kind: 'code_lines_edited',
          elementId: 'code-1',
          edit: {
            kind: 'delete_lines',
            lineIds: ['replacement-only', 'B', 'A', 'L3', 'L4'],
          },
        }),
      ),
    ]);
    expect(result.whiteboard?.elements[0]).toMatchObject({ type: 'code', lines: [] });
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
