import { normalizeElement, type CodeLine, type PPTElement, type Whiteboard } from '@openmaic/dsl';
import sceneSchemaJson from '@openmaic/dsl/schema/scene.schema.json';
import type { RuntimePayloadValidator } from '@openmaic/storage';

import { normalizeWhiteboardViewportRatio } from '@/lib/whiteboard/viewport';
import {
  LEGACY_WHITEBOARD_SOURCE_KIND,
  WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
  type Sha256Digest,
  type WhiteboardRuntimePayloadV1,
} from './types';

const MAX_OPERATION_ID_LENGTH = 512;
const MAX_FINGERPRINT_LENGTH = 71;
const SAFE_ID = /^[^\u0000-\u001f\u007f\u2028\u2029]+$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const WHITEBOARD_KEYS = new Set([
  'id',
  'viewportSize',
  'viewportRatio',
  'elements',
  'background',
  'animations',
  'script',
]);
const REQUIRED_WHITEBOARD_KEYS = new Set(['id', 'viewportSize', 'viewportRatio', 'elements']);
const PAYLOAD_KEYS = new Set(['payloadVersion', 'operationId', 'operation']);
const LEGACY_OPERATION_KEYS = new Set(['kind', 'source', 'whiteboard']);
const ELEMENT_ADDED_OPERATION_KEYS = new Set(['kind', 'element']);
const ELEMENT_DELETED_OPERATION_KEYS = new Set(['kind', 'elementId']);
const ELEMENTS_CLEARED_OPERATION_KEYS = new Set(['kind']);
const CODE_LINES_EDITED_OPERATION_KEYS = new Set(['kind', 'elementId', 'edit']);
const CODE_LINE_KEYS = new Set(['id', 'content']);
const CODE_LINES_INSERT_EDIT_KEYS = new Set(['kind', 'lineId', 'lines']);
const CODE_LINES_DELETE_EDIT_KEYS = new Set(['kind', 'lineIds']);
const CODE_LINES_REPLACE_EDIT_KEYS = new Set(['kind', 'lineIds', 'lines']);
const SOURCE_KEYS = new Set(['kind', 'fingerprint']);

type JsonSchema = {
  $ref?: string;
  anyOf?: JsonSchema[];
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};

type SchemaDocument = { definitions?: Record<string, JsonSchema> };
const schemaDefinitions = (sceneSchemaJson as SchemaDocument).definitions ?? {};
const ELEMENT_SCHEMA_DEFINITION_BY_TYPE = new Map<string, string>([
  ['text', 'PPTTextElement'],
  ['image', 'PPTImageElement'],
  ['shape', 'PPTShapeElement'],
  ['line', 'PPTLineElement'],
  ['chart', 'PPTChartElement'],
  ['table', 'PPTTableElement'],
  ['latex', 'PPTLatexElement'],
  ['video', 'PPTVideoElement'],
  ['audio', 'PPTAudioElement'],
  ['code', 'PPTCodeElement'],
]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$ref',
  'anyOf',
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'description',
  'default',
  'title',
  'examples',
]);

for (const definitionName of [
  ...ELEMENT_SCHEMA_DEFINITION_BY_TYPE.values(),
  'SlideBackground',
  'PPTAnimation',
]) {
  if (!schemaDefinitions[definitionName]) {
    throw new Error(
      `Whiteboard RuntimeStore validator requires generated schema definition ${JSON.stringify(definitionName)}`,
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyAllowedOwnKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasAllRequiredOwnKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
): boolean {
  return Array.from(required).every((key) => Object.hasOwn(value, key));
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  return (
    Object.keys(value).length === expected.size &&
    hasOnlyAllowedOwnKeys(value, expected) &&
    hasAllRequiredOwnKeys(value, expected)
  );
}

function isSafeIdentifier(value: unknown, maxLength = MAX_OPERATION_ID_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    SAFE_ID.test(value)
  );
}

function decodeRefName(ref: string): string | null {
  const match = ref.match(/^#\/definitions\/(.+)$/u);
  return match ? match[1]!.replace(/~1/gu, '/').replace(/~0/gu, '~') : null;
}

function resolveSchema(schema: JsonSchema, seen = new Set<string>()): JsonSchema {
  if (!schema.$ref) return schema;
  const name = decodeRefName(schema.$ref);
  if (!name || seen.has(name)) return schema;
  const target = schemaDefinitions[name];
  if (!target) return schema;
  seen.add(name);
  return resolveSchema(target, seen);
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return objectValue(value) !== null;
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function validateSchema(value: unknown, input: JsonSchema, path: string): string | null {
  const schema = resolveSchema(input);
  if (schema.$ref) return `${path} contains an unresolved schema reference`;
  if (Object.keys(schema).some((key) => !SUPPORTED_SCHEMA_KEYWORDS.has(key))) {
    return `${path} uses an unsupported schema construct`;
  }
  if (schema.anyOf) {
    if (schema.anyOf.some((option) => validateSchema(value, option, path) === null)) return null;
    return `${path} does not match any allowed schema`;
  }
  if ('const' in schema && !Object.is(value, schema.const)) {
    return `${path} must be ${JSON.stringify(schema.const)}`;
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    return `${path} is not an allowed value`;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(value, type))) {
      return `${path} has the wrong type`;
    }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path} must be finite`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is too small`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is too large`;
  }
  if (schema.properties) {
    const object = objectValue(value);
    if (!object) return `${path} must be a plain object`;
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(object, required)) return `${path}.${required} is required`;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!Object.hasOwn(schema.properties, key)) return `${path}.${key} is out of contract`;
      }
    }
    for (const [key, nested] of Object.entries(schema.properties)) {
      if (Object.hasOwn(object, key)) {
        const error = validateSchema(object[key], nested, `${path}.${key}`);
        if (error) return error;
      }
    }
  }
  if (schema.items) {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${path} has too few items`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${path} has too many items`;
    }
    if (Array.isArray(schema.items)) {
      if (value.length !== schema.items.length) return `${path} has the wrong tuple length`;
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchema(value[index], schema.items[index]!, `${path}[${index}]`);
        if (error) return error;
      }
    } else {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchema(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  return null;
}

function validateElement(element: PPTElement): string | null {
  const definitionName = ELEMENT_SCHEMA_DEFINITION_BY_TYPE.get(element.type);
  const schema = definitionName ? schemaDefinitions[definitionName] : undefined;
  return schema ? validateSchema(element, schema, 'element') : 'unknown element type';
}

function validateCodeLineTargetIds(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be non-empty`);
  const ids = new Set<string>();
  for (const id of value) {
    // Existing CodeLine.id values are plain strings in the frozen DSL contract. Targets must
    // remain able to address every line accepted by legacy import, including an empty ID.
    if (typeof id !== 'string') throw new Error(`${label} contains an invalid id`);
    if (ids.has(id)) throw new Error(`${label} contains a duplicate id`);
    ids.add(id);
  }
}

function validateCodeLines(
  value: unknown,
  label: string,
  options: { nonEmpty: boolean },
): asserts value is CodeLine[] {
  if (!Array.isArray(value) || (options.nonEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${options.nonEmpty ? 'a non-empty array' : 'an array'}`);
  }
  const ids = new Set<string>();
  for (const candidate of value) {
    const line = objectValue(candidate);
    if (!line || !hasExactOwnKeys(line, CODE_LINE_KEYS)) {
      throw new Error(`${label} contains an invalid code line`);
    }
    if (!isSafeIdentifier(line.id)) throw new Error(`${label} contains an invalid line id`);
    if (ids.has(line.id)) throw new Error(`${label} contains a duplicate line id`);
    if (typeof line.content !== 'string') throw new Error(`${label} contains invalid content`);
    ids.add(line.id);
  }
}

export function normalizeAndValidateWhiteboardElement(value: unknown): PPTElement {
  assertLosslessJson(value, '$');
  const normalized = normalizeElement(value as PPTElement);
  if (!isSafeIdentifier(normalized.id)) throw new Error('invalid element id');
  const error = validateElement(normalized);
  if (error) throw new Error(error);
  return cloneCanonicalJson(normalized);
}

function assertLosslessJson(value: unknown, path: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && (value.includes('\u0000') || /[\uD800-\uDFFF]/u.test(value))) {
      throw new Error(`${path} contains a non-portable string`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new Error(`${path} is not finite JSON`);
    return;
  }
  if (typeof value !== 'object') throw new Error(`${path} is not JSON`);
  if (seen.has(value)) throw new Error(`${path} is cyclic`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        const index = typeof key === 'string' ? Number(key) : Number.NaN;
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          throw new Error(`${path} has a non-index array property`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
          throw new Error(`${path}[${String(key)}] is not a plain data property`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error(`${path}[${index}] is sparse`);
        assertLosslessJson(value[index], `${path}[${index}]`, seen);
      }
      return;
    }
    const object = objectValue(value);
    if (!object) throw new Error(`${path} is not a plain object`);
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string') throw new Error(`${path} has a symbol key`);
      if (key.includes('\u0000') || /[\uD800-\uDFFF]/u.test(key)) {
        throw new Error(`${path} has a non-portable object key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
        throw new Error(`${path}.${key} is not a plain data property`);
      }
      assertLosslessJson(object[key], `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function cloneCanonicalJson<T>(value: T): T {
  assertLosslessJson(value, '$');
  const clone = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(clone);
    const object = objectValue(input);
    if (!object) return input;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      Object.defineProperty(output, key, {
        value: clone(object[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  };
  return clone(value) as T;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(cloneCanonicalJson(value));
}

export async function sha256Canonical(value: unknown): Promise<Sha256Digest> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 requires Web Crypto');
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function normalizeAndValidateLegacyWhiteboard(value: unknown): Whiteboard {
  assertLosslessJson(value, '$');
  const board = objectValue(value);
  if (
    !board ||
    !hasOnlyAllowedOwnKeys(board, WHITEBOARD_KEYS) ||
    !hasAllRequiredOwnKeys(board, REQUIRED_WHITEBOARD_KEYS)
  )
    throw new Error('invalid whiteboard envelope');
  if (!isSafeIdentifier(board.id)) throw new Error('invalid whiteboard id');
  if (typeof board.viewportSize !== 'number' || !Number.isFinite(board.viewportSize)) {
    throw new Error('invalid whiteboard viewportSize');
  }
  if (typeof board.viewportRatio !== 'number' || !Number.isFinite(board.viewportRatio)) {
    throw new Error('invalid whiteboard viewportRatio');
  }
  // viewportRatio is height/width; normalize an inverted persisted value
  // (> 1, i.e. 16:9 written as width/height) into the plausible band so an
  // inverted ratio cannot be committed again.
  const viewportRatio = normalizeWhiteboardViewportRatio(board.viewportRatio);
  if (!Array.isArray(board.elements)) throw new Error('invalid whiteboard elements');
  if (Object.hasOwn(board, 'background')) {
    const error = validateSchema(
      board.background,
      schemaDefinitions.SlideBackground ?? {},
      'background',
    );
    if (error) throw new Error(error);
  }
  if (Object.hasOwn(board, 'animations')) {
    if (!Array.isArray(board.animations)) throw new Error('invalid whiteboard animations');
    for (const animation of board.animations) {
      const error = validateSchema(animation, schemaDefinitions.PPTAnimation ?? {}, 'animation');
      if (error) throw new Error(error);
    }
  }
  if (Object.hasOwn(board, 'script') && typeof board.script !== 'string') {
    throw new Error('invalid whiteboard script');
  }

  const ids = new Set<string>();
  const elements = board.elements.map((candidate) => {
    const normalized = normalizeAndValidateWhiteboardElement(candidate);
    if (ids.has(normalized.id)) throw new Error('duplicate element id');
    ids.add(normalized.id);
    return normalized;
  });
  return cloneCanonicalJson({ ...board, elements, viewportRatio } as Whiteboard);
}

export function validateWhiteboardRuntimePayload(
  payload: unknown,
): { valid: true } | { valid: false; errors: { path: string; message: string }[] } {
  try {
    assertLosslessJson(payload, '$');
    const value = objectValue(payload);
    if (!value || !hasExactOwnKeys(value, PAYLOAD_KEYS)) {
      throw new Error('payload keys are invalid');
    }
    if (value.payloadVersion !== WHITEBOARD_RUNTIME_PAYLOAD_VERSION) {
      throw new Error('payloadVersion must be 1');
    }
    if (!isSafeIdentifier(value.operationId)) throw new Error('operationId is invalid');
    const operation = objectValue(value.operation);
    if (!operation) throw new Error('operation is invalid');
    if (operation.kind === 'legacy_snapshot_imported') {
      if (!hasExactOwnKeys(operation, LEGACY_OPERATION_KEYS)) {
        throw new Error('operation is invalid');
      }
      const source = objectValue(operation.source);
      if (!source || !hasExactOwnKeys(source, SOURCE_KEYS)) throw new Error('source is invalid');
      if (source.kind !== LEGACY_WHITEBOARD_SOURCE_KIND) throw new Error('source kind is invalid');
      if (
        typeof source.fingerprint !== 'string' ||
        source.fingerprint.length !== MAX_FINGERPRINT_LENGTH ||
        !SHA256.test(source.fingerprint)
      ) {
        throw new Error('source fingerprint is invalid');
      }
      const normalized = normalizeAndValidateLegacyWhiteboard(operation.whiteboard);
      // A persisted payload may carry the un-normalized inverted viewportRatio
      // (height/width written as width/height) that the fold repairs on read;
      // compare against the ratio-normalized expectation so such records replay.
      const whiteboard = operation.whiteboard as Record<string, unknown>;
      const expected = { ...whiteboard, viewportRatio: normalized.viewportRatio };
      if (canonicalJson(normalized) !== canonicalJson(expected)) {
        throw new Error('whiteboard payload is not canonical');
      }
    } else if (operation.kind === 'element_added') {
      if (!hasExactOwnKeys(operation, ELEMENT_ADDED_OPERATION_KEYS)) {
        throw new Error('operation is invalid');
      }
      const normalized = normalizeAndValidateWhiteboardElement(operation.element);
      if (canonicalJson(normalized) !== canonicalJson(operation.element)) {
        throw new Error('element payload is not canonical');
      }
    } else if (operation.kind === 'element_deleted') {
      if (!hasExactOwnKeys(operation, ELEMENT_DELETED_OPERATION_KEYS)) {
        throw new Error('operation is invalid');
      }
      if (!isSafeIdentifier(operation.elementId)) throw new Error('elementId is invalid');
    } else if (operation.kind === 'elements_cleared') {
      if (!hasExactOwnKeys(operation, ELEMENTS_CLEARED_OPERATION_KEYS)) {
        throw new Error('operation is invalid');
      }
    } else if (operation.kind === 'code_lines_edited') {
      if (!hasExactOwnKeys(operation, CODE_LINES_EDITED_OPERATION_KEYS)) {
        throw new Error('operation is invalid');
      }
      if (!isSafeIdentifier(operation.elementId)) throw new Error('elementId is invalid');
      const edit = objectValue(operation.edit);
      if (!edit) throw new Error('edit is invalid');
      if (edit.kind === 'insert_after' || edit.kind === 'insert_before') {
        if (!hasExactOwnKeys(edit, CODE_LINES_INSERT_EDIT_KEYS)) {
          throw new Error('edit is invalid');
        }
        if (typeof edit.lineId !== 'string') throw new Error('lineId is invalid');
        validateCodeLines(edit.lines, 'edit.lines', { nonEmpty: true });
      } else if (edit.kind === 'delete_lines') {
        if (!hasExactOwnKeys(edit, CODE_LINES_DELETE_EDIT_KEYS)) {
          throw new Error('edit is invalid');
        }
        validateCodeLineTargetIds(edit.lineIds, 'edit.lineIds');
      } else if (edit.kind === 'replace_lines') {
        if (!hasExactOwnKeys(edit, CODE_LINES_REPLACE_EDIT_KEYS)) {
          throw new Error('edit is invalid');
        }
        validateCodeLineTargetIds(edit.lineIds, 'edit.lineIds');
        validateCodeLines(edit.lines, 'edit.lines', { nonEmpty: true });
      } else {
        throw new Error('edit kind is invalid');
      }
    } else {
      throw new Error('operation kind is invalid');
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      errors: [
        { path: '/payload', message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}

export const whiteboardRuntimePayloadValidator: RuntimePayloadValidator =
  validateWhiteboardRuntimePayload;

export function assertWhiteboardRuntimePayload(
  payload: unknown,
): asserts payload is WhiteboardRuntimePayloadV1 {
  const result = validateWhiteboardRuntimePayload(payload);
  if (!result.valid)
    throw new Error(`Invalid whiteboard runtime payload: ${result.errors[0]?.message}`);
}
