import type { EditIntent } from '@openmaic/renderer/editing';
import type { PPTElement } from '@openmaic/dsl';
import sanitizeHtml from 'sanitize-html';
import { isExactContentEditable } from './edit-elements-content-contract';
import {
  ALLOWED_EDIT_PROPS,
  buildElementInventory,
  mapProposalsToEditIntents,
  revalidateIntentsAgainstElements,
  validateElementAgainstDslSchema,
  type ProposedElementUpdate,
} from './edit-elements-gate';

export type ElementJsonPatchOperation =
  | { op: 'test'; path: string; value: unknown }
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown };

export type ElementJsonPatchResult =
  | { ok: true; intents: EditIntent[]; targetIds: string[] }
  | { ok: false; reason: string };

const SHAPE_TEXT_PATH_TO_INTENT_PROP = new Map([
  ['defaultColor', 'defaultColor'],
  ['defaultFontName', 'defaultFontName'],
  ['lineHeight', 'lineHeight'],
  ['wordSpace', 'wordSpace'],
  ['paragraphSpace', 'paragraphSpace'],
  ['align', 'vAlign'],
]);

const PARTIALLY_MERGED_STYLE_PROPS = new Set(['outline', 'shadow', 'filters']);

const SAFE_CSS_VALUE =
  /^(?!.*(?:\\|\/\*|@|url\s*\(|expression\s*\(|javascript\s*:|data\s*:|[{}]))[\s\S]+$/i;
const SAFE_LAYOUT_VALUE =
  /^-?\d+(?:\.\d+)?(?:px|pt|%|em|rem)?(?:\s+-?\d+(?:\.\d+)?(?:px|pt|%|em|rem)?){0,3}$/i;
const SAFE_GRADIENT_VALUE =
  /^(?!.*(?:\\|\/\*|@|url\s*\(|expression\s*\(|javascript\s*:|data\s*:|[{}]))(?:linear|radial)-gradient\([\s\S]+\)$/i;
const SAFE_WARP_TRANSFORM =
  /^translate\(-?\d+(?:\.\d+)?%,\s*-?\d+(?:\.\d+)?%\)\s+rotate\(-?\d+(?:\.\d+)?deg\)$/i;
const SAFE_RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'div',
    'br',
    'span',
    'mark',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'strike',
    'sub',
    'sup',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'a',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel', 'style'],
    div: ['style', 'data-*'],
    p: ['style', 'data-*'],
    span: ['style', 'data-*'],
    br: ['class'],
    mark: ['data-index'],
    ol: ['start', 'reversed', 'type', 'style'],
    ul: ['style'],
    li: ['value'],
  },
  allowedClasses: { br: ['ProseMirror-trailingBreak'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  allowedStyles: {
    '*': {
      color: [SAFE_CSS_VALUE],
      'background-color': [SAFE_CSS_VALUE],
      background: [SAFE_GRADIENT_VALUE],
      'background-clip': [SAFE_CSS_VALUE],
      '-webkit-background-clip': [SAFE_CSS_VALUE],
      'font-family': [SAFE_CSS_VALUE],
      'font-size': [SAFE_CSS_VALUE],
      'font-weight': [SAFE_CSS_VALUE],
      'font-style': [SAFE_CSS_VALUE],
      font: [SAFE_CSS_VALUE],
      'text-decoration': [SAFE_CSS_VALUE],
      'text-decoration-line': [SAFE_CSS_VALUE],
      'text-align': [SAFE_CSS_VALUE],
      'text-shadow': [SAFE_CSS_VALUE],
      'line-height': [SAFE_CSS_VALUE],
      'letter-spacing': [SAFE_CSS_VALUE],
      'font-kerning': [SAFE_CSS_VALUE],
      'font-variant': [SAFE_CSS_VALUE],
      'text-transform': [SAFE_CSS_VALUE],
      'vertical-align': [SAFE_CSS_VALUE],
      'text-indent': [SAFE_CSS_VALUE],
      margin: [SAFE_LAYOUT_VALUE],
      'margin-left': [SAFE_LAYOUT_VALUE],
      'margin-right': [SAFE_LAYOUT_VALUE],
      'margin-top': [SAFE_LAYOUT_VALUE],
      'margin-bottom': [SAFE_LAYOUT_VALUE],
      'margin-block': [SAFE_CSS_VALUE],
      'margin-block-end': [SAFE_CSS_VALUE],
      opacity: [SAFE_CSS_VALUE],
      display: [/^(?:none|block|inline|inline-block|flex|inline-flex)$/i],
      position: [/^(?:relative|absolute)$/i],
      left: [SAFE_LAYOUT_VALUE],
      right: [SAFE_LAYOUT_VALUE],
      top: [SAFE_LAYOUT_VALUE],
      bottom: [SAFE_LAYOUT_VALUE],
      width: [SAFE_LAYOUT_VALUE],
      height: [SAFE_LAYOUT_VALUE],
      'min-height': [SAFE_LAYOUT_VALUE],
      padding: [SAFE_LAYOUT_VALUE],
      'padding-top': [SAFE_LAYOUT_VALUE],
      'padding-left': [SAFE_LAYOUT_VALUE],
      'padding-right': [SAFE_LAYOUT_VALUE],
      overflow: [/^(?:visible|hidden|clip)$/i],
      'white-space': [/^(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/i],
      'tab-size': [SAFE_LAYOUT_VALUE],
      transform: [SAFE_WARP_TRANSFORM],
      'transform-origin': [/^center center$/i],
      'box-sizing': [/^border-box$/i],
      'list-style-type': [SAFE_CSS_VALUE],
      visibility: [SAFE_CSS_VALUE],
      'writing-mode': [SAFE_CSS_VALUE],
      '-webkit-writing-mode': [SAFE_CSS_VALUE],
      '-webkit-text-fill-color': [SAFE_CSS_VALUE],
      '-webkit-text-stroke-width': [SAFE_CSS_VALUE],
      '-webkit-text-stroke-color': [SAFE_CSS_VALUE],
      'paint-order': [SAFE_CSS_VALUE],
      'mask-image': [SAFE_GRADIENT_VALUE],
      '-webkit-mask-image': [SAFE_GRADIENT_VALUE],
      all: [SAFE_CSS_VALUE],
    },
  },
};

const CANONICAL_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: false,
  allowedAttributes: false,
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'javascript', 'data', 'vbscript'],
  allowProtocolRelative: true,
  allowVulnerableTags: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodePointer(path: string): string[] | null {
  if (!path.startsWith('/')) return null;
  const segments = path
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  return segments.some((segment) => /~(?:[^01]|$)/.test(segment)) ? null : segments;
}

function elementPath(path: string): { index: number; tail: string[] } | null {
  const segments = decodePointer(path);
  if (!segments || segments[0] !== 'elements' || !/^(0|[1-9]\d*)$/.test(segments[1] ?? '')) {
    return null;
  }
  return { index: Number(segments[1]), tail: segments.slice(2) };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeProperty(
  root: unknown,
  path: string[],
  value: unknown,
  operation: 'add' | 'replace',
): string | null {
  if (path.length === 0) return `cannot ${operation} a whole element`;
  let parent: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(parent) || !Object.prototype.hasOwnProperty.call(parent, segment)) {
      return `path segment ${JSON.stringify(segment)} does not exist`;
    }
    parent = parent[segment];
  }
  const key = path[path.length - 1];
  if (
    !isRecord(parent) ||
    (operation === 'replace' && !Object.prototype.hasOwnProperty.call(parent, key))
  ) {
    return `path segment ${JSON.stringify(key)} does not exist`;
  }
  if (operation === 'add' && Object.prototype.hasOwnProperty.call(parent, key)) {
    return 'add only supports an absent optional property';
  }
  parent[key] = structuredClone(value);
  return null;
}

function isSafeRichText(content: string): boolean {
  return (
    sanitizeHtml(content, SAFE_RICH_TEXT_OPTIONS) === sanitizeHtml(content, CANONICAL_HTML_OPTIONS)
  );
}

function mappedPropsById(intents: EditIntent[]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const intent of intents) {
    if (intent.type === 'element.update') {
      result.set(intent.id, intent.props as Record<string, unknown>);
    } else if (intent.type === 'element.updateMany') {
      for (const update of intent.updates) {
        result.set(update.id, update.props as Record<string, unknown>);
      }
    }
  }
  return result;
}

function editablePath(element: PPTElement, tail: string[]): boolean {
  if (tail.length === 0) return false;
  if (element.type === 'text' && tail.length === 1 && tail[0] === 'content') return true;
  if (element.type === 'shape' && tail[0] === 'text') {
    if (tail.length !== 2) return false;
    return tail[1] === 'content' || SHAPE_TEXT_PATH_TO_INTENT_PROP.has(tail[1]);
  }
  return ALLOWED_EDIT_PROPS.has(tail[0]);
}

function textContentIntent(
  original: PPTElement,
  patched: PPTElement,
): Extract<EditIntent, { type: 'text.updateContent' }> | null {
  if (original.type === 'text' && patched.type === 'text') {
    if (original.content === patched.content) return null;
    return {
      type: 'text.updateContent',
      id: original.id,
      content: patched.content,
      target: 'text',
    };
  }
  if (original.type === 'shape' && patched.type === 'shape') {
    const before = original.text?.content;
    const after = patched.text?.content;
    if (before === after || after === undefined) return null;
    return { type: 'text.updateContent', id: original.id, content: after, target: 'shape' };
  }
  return null;
}

function styleProposal(original: PPTElement, patched: PPTElement): ProposedElementUpdate | null {
  const before = original as unknown as Record<string, unknown>;
  const after = patched as unknown as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  for (const key of ALLOWED_EDIT_PROPS) {
    if (!deepEqual(before[key], after[key])) props[key] = after[key];
  }
  if (original.type === 'shape' && patched.type === 'shape') {
    for (const [pathKey, intentKey] of SHAPE_TEXT_PATH_TO_INTENT_PROP) {
      const beforeValue = original.text?.[pathKey as keyof NonNullable<typeof original.text>];
      const afterValue = patched.text?.[pathKey as keyof NonNullable<typeof patched.text>];
      if (!deepEqual(beforeValue, afterValue)) props[intentKey] = afterValue;
    }
  }
  return Object.keys(props).length > 0 ? { id: original.id, props } : null;
}

function applyContentChangesForValidation(
  original: PPTElement[],
  patched: PPTElement[],
): PPTElement[] {
  return original.map((element, index) => {
    const next = structuredClone(element);
    const patchedElement = patched[index];
    if (next.type === 'text' && patchedElement?.type === 'text') {
      next.content = patchedElement.content;
    } else if (next.type === 'shape' && patchedElement?.type === 'shape' && next.text) {
      next.text.content = patchedElement.text?.content ?? next.text.content;
    }
    return next;
  });
}

/**
 * Convert guarded RFC 6902 `test`/`add`/`replace` operations into the existing host
 * EditIntent batch. The input elements are never mutated.
 */
export function mapElementJsonPatchToEditIntents(
  operations: unknown,
  elements: PPTElement[],
): ElementJsonPatchResult {
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, reason: 'no JSON Patch operations proposed' };
  }

  const seenElementIds = new Set<string>();
  for (const element of elements) {
    if (seenElementIds.has(element.id)) {
      return {
        ok: false,
        reason: `slide contains duplicate element id ${JSON.stringify(element.id)}`,
      };
    }
    seenElementIds.add(element.id);
  }

  const patched = structuredClone(elements);
  const guarded = new Map<number, string>();
  const targetIds: string[] = [];
  const targeted = new Set<string>();
  const partialStructuredKeysById = new Map<string, Map<string, Set<string>>>();
  const wholeObjectWritesById = new Map<string, Set<string>>();
  const wholeObjectReplacementsById = new Map<string, Set<string>>();

  for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
    const operation = operations[operationIndex];
    if (!isRecord(operation) || typeof operation.op !== 'string') {
      return { ok: false, reason: `operation ${operationIndex} is malformed` };
    }
    if (operation.op !== 'test' && operation.op !== 'add' && operation.op !== 'replace') {
      return {
        ok: false,
        reason: `operation ${operationIndex} uses unsupported op ${JSON.stringify(operation.op)}`,
      };
    }
    if (typeof operation.path !== 'string' || !('value' in operation)) {
      return { ok: false, reason: `operation ${operationIndex} is malformed` };
    }
    const parsed = elementPath(operation.path);
    if (!parsed || parsed.index >= patched.length) {
      return { ok: false, reason: `path ${operation.path} does not target an existing element` };
    }
    const element = patched[parsed.index];

    if (operation.op === 'test') {
      if (parsed.tail.length !== 1 || parsed.tail[0] !== 'id') {
        return { ok: false, reason: `only element id test operations are supported` };
      }
      if (operation.value !== element.id) {
        return { ok: false, reason: `test failed at ${operation.path}` };
      }
      guarded.set(parsed.index, element.id);
      continue;
    }

    if (guarded.get(parsed.index) !== element.id) {
      return {
        ok: false,
        reason: `element index ${parsed.index} must be guarded by a preceding id test`,
      };
    }
    if (!editablePath(element, parsed.tail)) {
      return { ok: false, reason: `path ${operation.path} is not editable` };
    }
    if (element.lock)
      return { ok: false, reason: `element ${JSON.stringify(element.id)} is locked` };
    if (
      (element.type === 'text' && parsed.tail.join('/') === 'content') ||
      (element.type === 'shape' && parsed.tail.join('/') === 'text/content')
    ) {
      if (typeof operation.value !== 'string') {
        return {
          ok: false,
          reason: `${element.type === 'text' ? 'text' : 'shape text'} content must be a string`,
        };
      }
      const originalContent =
        element.type === 'text' ? element.content : (element.text?.content ?? '');
      if (!isExactContentEditable(originalContent)) {
        return {
          ok: false,
          reason: `${element.type === 'text' ? 'text' : 'shape text'} content is too large for exact JSON Patch replacement`,
        };
      }
      if (!isExactContentEditable(operation.value)) {
        return {
          ok: false,
          reason: `new ${element.type === 'text' ? 'text' : 'shape text'} content is too large for exact JSON Patch replacement`,
        };
      }
      if (!isSafeRichText(operation.value)) {
        return {
          ok: false,
          reason: `${element.type === 'text' ? 'text' : 'shape text'} content contains unsafe HTML`,
        };
      }
    }
    const writeError = writeProperty(element, parsed.tail, operation.value, operation.op);
    if (writeError) return { ok: false, reason: `${operation.path}: ${writeError}` };
    const [rootKey, nestedKey] = parsed.tail;
    if (nestedKey && PARTIALLY_MERGED_STYLE_PROPS.has(rootKey)) {
      let props = partialStructuredKeysById.get(element.id);
      if (!props) {
        props = new Map();
        partialStructuredKeysById.set(element.id, props);
      }
      let keys = props.get(rootKey);
      if (!keys) {
        keys = new Set();
        props.set(rootKey, keys);
      }
      keys.add(nestedKey);
    } else if (parsed.tail.length === 1 && PARTIALLY_MERGED_STYLE_PROPS.has(rootKey)) {
      let writes = wholeObjectWritesById.get(element.id);
      if (!writes) {
        writes = new Set();
        wholeObjectWritesById.set(element.id, writes);
      }
      writes.add(rootKey);
      if (operation.op === 'replace') {
        let props = wholeObjectReplacementsById.get(element.id);
        if (!props) {
          props = new Set();
          wholeObjectReplacementsById.set(element.id, props);
        }
        props.add(rootKey);
      }
    }
    if (!targeted.has(element.id)) {
      targeted.add(element.id);
      targetIds.push(element.id);
    }
  }

  for (const id of targetIds) {
    const index = elements.findIndex((element) => element.id === id);
    const schemaError = validateElementAgainstDslSchema(patched[index]);
    if (schemaError) return { ok: false, reason: schemaError };
  }

  const proposals = targetIds
    .map((id) => {
      const index = elements.findIndex((element) => element.id === id);
      return styleProposal(elements[index], patched[index]);
    })
    .filter((proposal): proposal is ProposedElementUpdate => proposal !== null);

  const intents: EditIntent[] = [];
  if (proposals.length > 0) {
    const inventory = buildElementInventory(applyContentChangesForValidation(elements, patched));
    const mapped = mapProposalsToEditIntents(proposals, inventory, {
      replacedPropsById: wholeObjectReplacementsById,
      additionalGroupTargetIds: new Set(targetIds),
    });
    if (!mapped.ok) return mapped;
    const mappedProps = mappedPropsById(mapped.intents);
    const validatedUpdates: Array<{ id: string; props: Partial<PPTElement> }> = [];
    for (const proposal of proposals) {
      const normalized = mappedProps.get(proposal.id);
      if (!normalized) {
        return {
          ok: false,
          reason: `validated update missing for element ${JSON.stringify(proposal.id)}`,
        };
      }
      const narrowed: Record<string, unknown> = {};
      for (const [key, requestedValue] of Object.entries(proposal.props)) {
        const normalizedValue = normalized[key];
        const partialKeys = partialStructuredKeysById.get(proposal.id)?.get(key);
        const wholeObjectWrite = wholeObjectWritesById.get(proposal.id)?.has(key);
        if (
          partialKeys &&
          !wholeObjectWrite &&
          isRecord(requestedValue) &&
          isRecord(normalizedValue)
        ) {
          const partial = Object.fromEntries(
            [...partialKeys].map((partialKey) => [partialKey, normalizedValue[partialKey]]),
          );
          const requestedPartial = Object.fromEntries(
            [...partialKeys].map((partialKey) => [partialKey, requestedValue[partialKey]]),
          );
          if (!deepEqual(partial, requestedPartial)) {
            return {
              ok: false,
              reason: `patch values for element ${JSON.stringify(proposal.id)} would be normalized; submit canonical values already within renderer bounds and units`,
            };
          }
          narrowed[key] = partial;
        } else {
          if (!deepEqual(normalizedValue, requestedValue)) {
            return {
              ok: false,
              reason: `patch values for element ${JSON.stringify(proposal.id)} would be normalized; submit canonical values already within renderer bounds and units`,
            };
          }
          narrowed[key] = normalizedValue;
        }
      }
      validatedUpdates.push({ id: proposal.id, props: narrowed as Partial<PPTElement> });
    }
    for (const proposal of proposals) {
      const replacements = wholeObjectReplacementsById.get(proposal.id);
      const props = replacements
        ? [...replacements].filter((key) =>
            Object.prototype.hasOwnProperty.call(proposal.props, key),
          )
        : [];
      if (props.length > 0) {
        intents.push({ type: 'element.removeProps', id: proposal.id, props });
      }
    }
    intents.push(
      validatedUpdates.length === 1
        ? { type: 'element.update', ...validatedUpdates[0] }
        : { type: 'element.updateMany', updates: validatedUpdates },
    );
  }
  for (const id of targetIds) {
    const index = elements.findIndex((element) => element.id === id);
    const intent = textContentIntent(elements[index], patched[index]);
    if (intent) intents.push(intent);
  }

  if (intents.length === 0) return { ok: false, reason: 'patch does not change any element' };
  const recheck = revalidateIntentsAgainstElements(elements, intents);
  if (!recheck.ok) return recheck;
  return { ok: true, intents, targetIds };
}
