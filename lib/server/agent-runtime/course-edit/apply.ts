/** Shared scene projections and generic JSON/slide transforms for stage tools. */
import { nanoid } from 'nanoid';
import { renderLatexElementHtml } from '@/lib/edit/slide-edit-elements';
import { validateElementInput, validateSlideCanvas } from './element-schema';
import type { PBLProjectV2, PBLRole } from '@/lib/pbl/v2/types';
import type { Action } from '@/lib/types/action';
import type { QuizContent, Scene, SlideContent } from '@/lib/types/stage';
import type { WidgetConfig } from '@/lib/types/widgets';
import { normalizeElement, type PPTElement } from '@openmaic/dsl';
import {
  containsReadSceneMediaPlaceholder,
  containsReadScenePlaceholderFragment,
} from './media-byte-omission';

export type ApplyResult<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): ApplyResult<T> {
  return { ok: true, value };
}
function fail(error: string): ApplyResult<never> {
  return { ok: false, error };
}

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findElement(content: SlideContent, elementId: string): PPTElement | undefined {
  return content.canvas.elements.find((el) => el.id === elementId);
}

export function inventorySlide(content: SlideContent) {
  return content.canvas.elements.map((el) => {
    const rec = el as PPTElement & {
      content?: string;
      text?: { content?: string };
      src?: string;
      mediaRef?: string;
      poster?: string;
      latex?: string;
      lines?: { content?: string }[];
      data?: { text?: string }[][];
    };
    let text = '';
    if (rec.type === 'text') text = stripTags(rec.content ?? '');
    else if (rec.type === 'shape') text = stripTags(rec.text?.content ?? '');
    else if (rec.type === 'latex') text = rec.latex ?? '';
    else if (rec.type === 'code') text = (rec.lines ?? []).map((l) => l.content).join('\n');
    else if (rec.type === 'table')
      text = (rec.data ?? [])
        .flat()
        .map((c) => c.text ?? '')
        .filter(Boolean)
        .join(' | ');
    return {
      id: rec.id,
      type: rec.type,
      text,
      left: rec.left,
      top: rec.top,
      width: 'width' in rec ? rec.width : undefined,
      height: 'height' in rec ? rec.height : undefined,
      src: rec.src,
      ...(rec.mediaRef !== undefined ? { mediaRef: rec.mediaRef } : {}),
      ...(rec.poster !== undefined ? { poster: rec.poster } : {}),
    };
  });
}

interface SlideTextEntry {
  /** Field-level pointer (relative to scene /content) of the stored string. */
  path: string;
  id: string;
  type: string;
  text: string;
  /** The stored value is HTML; `text` shows it with tags stripped. */
  html?: true;
}

function slideElementText(element: PPTElement, index: number): SlideTextEntry[] {
  const base = `/canvas/elements/${index}`;
  const rec = element as PPTElement & {
    content?: unknown;
    text?: { content?: unknown };
    latex?: unknown;
    lines?: { content?: unknown }[];
    data?: { text?: unknown }[][];
  };
  const entry = (path: string, text: unknown, html = false): SlideTextEntry[] => {
    if (typeof text !== 'string') return [];
    const visible = html ? stripTags(text) : text;
    if (!visible) return [];
    return [
      { path, id: rec.id, type: rec.type, text: visible, ...(html ? { html: true as const } : {}) },
    ];
  };
  if (rec.type === 'text') return entry(`${base}/content`, rec.content, true);
  if (rec.type === 'shape') return entry(`${base}/text/content`, rec.text?.content, true);
  if (rec.type === 'latex') return entry(`${base}/latex`, rec.latex);
  if (rec.type === 'code') {
    return (Array.isArray(rec.lines) ? rec.lines : []).flatMap((line, lineIndex) =>
      entry(`${base}/lines/${lineIndex}/content`, line?.content),
    );
  }
  if (rec.type === 'table') {
    return (Array.isArray(rec.data) ? rec.data : []).flatMap((row, rowIndex) =>
      (Array.isArray(row) ? row : []).flatMap((cell, cellIndex) =>
        entry(`${base}/data/${rowIndex}/${cellIndex}/text`, cell?.text),
      ),
    );
  }
  return [];
}

/**
 * Whole-page visible-text view used to prove old copy has no residue. Every
 * entry's `path` addresses the exact stored string field, so it can be passed
 * straight to `set`/`str_replace` (after the scene `/content` prefix).
 */
export function textSlide(content: SlideContent) {
  const inventory = inventorySlide(content);
  const elements = content.canvas.elements.flatMap(slideElementText);
  const media: {
    path: string;
    id: string;
    type: string;
    src?: string;
    mediaRef?: string;
    poster?: string;
  }[] = inventory.flatMap((element, index) => {
    const path = `/canvas/elements/${index}`;
    return (['src', 'mediaRef', 'poster'] as const).flatMap((field) =>
      typeof element[field] === 'string'
        ? [
            {
              path: `${path}/${field}`,
              id: element.id,
              type: element.type,
              [field]: element[field],
            },
          ]
        : [],
    );
  });
  const background = content.canvas.background;
  if (background?.type === 'image' && background.image?.src) {
    media.unshift({
      path: '/canvas/background/image/src',
      id: content.canvas.id,
      type: 'background',
      src: background.image.src,
    });
  }
  return {
    elements,
    combinedText: elements.map((element) => element.text).join('\n'),
    media,
  };
}

/**
 * Server course-agent surface only. The classroom/browser editor uses the
 * lower-level `SlideEditOperation` union in `lib/edit/slide-ops.ts` directly;
 * keep that UI contract independent from which sugar ops the agent exposes.
 */
export type SlideEditOp =
  | {
      op: 'patch';
      action: 'set' | 'remove';
      path: string;
      value?: unknown;
    }
  | {
      op: 'add_element';
      element: Record<string, unknown>;
      afterId?: string;
      index?: number;
    }
  | { op: 'delete_element'; elementId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodePointer(path: string): ApplyResult<string[]> {
  if (!path.startsWith('/') || path === '/') {
    return fail('patch path must be a non-root JSON Pointer beginning with /');
  }
  const encoded = path.slice(1).split('/');
  const decoded: string[] = [];
  for (const token of encoded) {
    if (/~(?:[^01]|$)/.test(token)) {
      return fail(`bad JSON pointer escape in path ${JSON.stringify(path)}`);
    }
    decoded.push(token.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return ok(decoded);
}

function arrayIndex(token: string, length: number): ApplyResult<number> {
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    return fail(`array path segment ${JSON.stringify(token)} is not a canonical index`);
  }
  const index = Number(token);
  if (index >= length) {
    return fail(`array index ${index} is out of bounds (current length ${length})`);
  }
  return ok(index);
}

/** `set` at index == length (or the RFC 6901 `-` token) appends to the array. */
function isAppendToken(token: string, length: number): boolean {
  return token === '-' || token === String(length);
}

function applyPointer(
  root: Record<string, unknown>,
  tokens: string[],
  action: 'set' | 'remove',
  value: unknown,
): ApplyResult<void> {
  let parent: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const parsed = arrayIndex(token, parent.length);
      if (!parsed.ok) return parsed;
      parent = parent[parsed.value];
    } else if (isRecord(parent)) {
      if (!Object.prototype.hasOwnProperty.call(parent, token)) {
        return fail(`patch path does not exist at ${JSON.stringify(token)}`);
      }
      parent = parent[token];
    } else {
      return fail(`patch path crosses a non-container at ${JSON.stringify(token)}`);
    }
  }
  const key = tokens.at(-1);
  if (key === undefined) return fail('patch path must address a field');
  if (Array.isArray(parent)) {
    if (action === 'set' && isAppendToken(key, parent.length)) {
      parent.push(structuredClone(value));
      return ok(undefined);
    }
    const parsed = arrayIndex(key, parent.length);
    if (!parsed.ok) return parsed;
    if (action === 'remove') parent.splice(parsed.value, 1);
    else parent[parsed.value] = structuredClone(value);
    return ok(undefined);
  }
  if (!isRecord(parent)) return fail('patch path parent is not an object or array');
  if (action === 'remove') {
    if (!Object.prototype.hasOwnProperty.call(parent, key)) {
      return fail(`patch remove path does not exist: ${JSON.stringify(key)}`);
    }
    delete parent[key];
  } else {
    Object.defineProperty(parent, key, {
      value: structuredClone(value),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return ok(undefined);
}

/** Read-side media omission placeholders are never persisted data. */
const READ_PLACEHOLDER_REJECTION =
  'patch rejected: that is a read-time placeholder, not a real src; write a new media src/URL instead of writing the placeholder text back into the document';

/**
 * Shared JSON Pointer primitive for the course DSL spike. It deliberately has
 * the same bounded-array, missing-parent, deep-clone, and media-placeholder
 * semantics as the stage DSL slide path. Domain identity and resulting-document validation
 * remain the caller's responsibility.
 */
export function applyJsonPointerEdit<T>(
  root: T,
  input: { action: 'set' | 'remove'; path: string; value?: unknown },
): ApplyResult<T> {
  if (input.action === 'set' && input.value === undefined) {
    return fail('patch set needs value (use action:"remove" to delete an optional field)');
  }
  if (input.action === 'remove' && input.value !== undefined) {
    return fail('patch remove must not include value');
  }
  if (input.action === 'set' && containsReadSceneMediaPlaceholder(input.value)) {
    return fail(READ_PLACEHOLDER_REJECTION);
  }
  const decoded = decodePointer(input.path);
  if (!decoded.ok) return decoded;
  const next = structuredClone(root);
  const applied = applyPointer(
    next as unknown as Record<string, unknown>,
    decoded.value,
    input.action,
    input.value,
  );
  return applied.ok ? ok(next) : applied;
}

export interface StrReplaceInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export type StrReplaceResult<T> =
  | { ok: true; value: T; occurrences: number }
  | { ok: false; error: string };

function failStr(error: string): StrReplaceResult<never> {
  return { ok: false as const, error };
}

function strReplaceMissing(path: string): StrReplaceResult<never> {
  return failStr(`str_replace requires a string field; ${path} is missing`);
}

function encodePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export interface StringField {
  path: string;
  value: string;
}

/**
 * Every string leaf under `value`, as scene-rooted JSON Pointers that can be
 * passed straight back to `set`/`str_replace`.
 */
export function collectStringFields(value: unknown, base = ''): StringField[] {
  const out: StringField[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') out.push({ path, value: node });
    else if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${path}/${index}`));
    else if (isRecord(node)) {
      for (const [key, item] of Object.entries(node)) {
        walk(item, `${path}/${encodePointerToken(key)}`);
      }
    }
  };
  walk(value, base);
  return out;
}

const MAX_LISTED_FIELDS = 12;
const FIELD_PREVIEW_CHARS = 60;

function previewText(text: string, max = FIELD_PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A short listing of the string fields nearest to `path` (under the deepest
 * container of `path` that exists), so a model that guessed the wrong field
 * name sees the real writable pointers.
 */
export function describeStringFieldsNear(root: unknown, path: string): string {
  const decoded = decodePointer(path);
  if (!decoded.ok) return '';
  let node: unknown = root;
  let base = '';
  for (const token of decoded.value) {
    let child: unknown;
    if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(token) && Number(token) < node.length) {
      child = node[Number(token)];
    } else if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, token)) {
      child = node[token];
    } else break;
    if (child === null || typeof child !== 'object') break;
    node = child;
    base += `/${encodePointerToken(token)}`;
  }
  if (base === '') return '';
  const fields = collectStringFields(node, base).filter((field) => field.value.trim());
  if (fields.length === 0) return '';
  const listed = fields
    .slice(0, MAX_LISTED_FIELDS)
    .map((field) => `${field.path} = ${JSON.stringify(previewText(field.value))}`);
  const more =
    fields.length > MAX_LISTED_FIELDS ? ` (+${fields.length - MAX_LISTED_FIELDS} more)` : '';
  return `String fields under ${base}: ${listed.join('; ')}${more}`;
}

const EXCERPT_CHARS = 200;
const MAX_SIMILARITY_WORK = 2_000_000;

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Locate the window of `text` most similar to `anchor` (bigram Dice score)
 * and return a ~200 character excerpt around it. Diagnostic only: the result
 * is shown to the model and is never written back.
 */
export function closestExcerpt(
  text: string,
  anchor: string,
): { excerpt: string; score: number } | null {
  const needle = anchor.toLowerCase();
  const haystack = text.toLowerCase();
  if (needle.length < 2 || haystack.length < 2) return null;
  const target = bigramCounts(needle);
  const targetSize = needle.length - 1;
  const width = Math.min(needle.length, haystack.length);
  const windows = haystack.length - width + 1;
  const step = Math.max(
    1,
    Math.floor(width / 4),
    Math.ceil((windows * width) / MAX_SIMILARITY_WORK),
  );
  let best = { start: 0, score: -1 };
  const consider = (start: number) => {
    const window = bigramCounts(haystack.slice(start, start + width));
    let shared = 0;
    for (const [gram, count] of window) shared += Math.min(count, target.get(gram) ?? 0);
    const score = (2 * shared) / (targetSize + width - 1);
    if (score > best.score) best = { start, score };
  };
  for (let start = 0; start < windows; start += step) consider(start);
  if (windows > 1) consider(windows - 1);
  const span = Math.max(EXCERPT_CHARS, width);
  const from = Math.max(0, Math.min(text.length - span, best.start - (span - width) / 2));
  const start = Math.floor(from);
  const excerpt = text.slice(start, start + span);
  return {
    excerpt: `${start > 0 ? '…' : ''}${excerpt}${start + span < text.length ? '…' : ''}`,
    score: best.score,
  };
}

/** Anchors scoring below this are not worth showing as "closest" text. */
const MIN_EXCERPT_SCORE = 0.3;

/** Diagnostic suffix for an anchor that does not occur in `text`. */
export function anchorNotFoundHint(text: string, anchor: string): string {
  const hints: string[] = [];
  const visibleAnchor = anchor.replace(/\s+/g, ' ').trim();
  if (visibleAnchor && /<[^>]+>/.test(text) && stripTags(text).includes(visibleAnchor)) {
    hints.push(
      'the anchor matches the visible text, but the stored value has HTML markup inside it; anchor on the exact stored text from read_stage detail:"source"',
    );
  }
  const closest = closestExcerpt(text, anchor);
  if (closest && closest.score >= MIN_EXCERPT_SCORE) {
    hints.push(`closest stored text: ${JSON.stringify(closest.excerpt)}`);
  }
  return hints.length ? `; ${hints.join('; ')}` : '';
}

function strReplaceTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Exact-text ("str_replace") replacement inside ONE string field, aligned with
 * Claude Code Edit semantics. The anchor must occur exactly once in the stored
 * value (or every occurrence with `replaceAll`), counting non-overlapping
 * exact matches. Read-side media omission placeholders are rejected in both
 * the anchor and the replacement so a read projection can never leak into
 * persisted data. The input is never mutated; the caller's clone discipline
 * matches `applyJsonPointerEdit`.
 */
export function applyStrReplace<T>(root: T, input: StrReplaceInput): StrReplaceResult<T> {
  if (input.oldText === '') return failStr('str_replace needs a non-empty oldText');
  const decoded = decodePointer(input.path);
  if (!decoded.ok) return decoded;
  const next = structuredClone(root);
  let parent: unknown = next;
  const tokens = decoded.value;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const parsed = arrayIndex(token, parent.length);
      if (!parsed.ok) return parsed;
      parent = parent[parsed.value];
    } else if (isRecord(parent)) {
      if (!Object.prototype.hasOwnProperty.call(parent, token)) {
        return strReplaceMissing(input.path);
      }
      parent = parent[token];
    } else {
      return strReplaceMissing(input.path);
    }
  }
  const key = tokens.at(-1);
  if (key === undefined) return failStr('patch path must address a field');
  let current: unknown;
  if (Array.isArray(parent)) {
    const parsed = arrayIndex(key, parent.length);
    if (!parsed.ok) return parsed;
    current = parent[parsed.value];
  } else if (isRecord(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, key)) {
      return strReplaceMissing(input.path);
    }
    current = parent[key];
  } else {
    return strReplaceMissing(input.path);
  }
  if (typeof current !== 'string') {
    return failStr(
      `str_replace requires a string field; ${input.path} is ${strReplaceTypeName(current)}`,
    );
  }
  if (containsReadScenePlaceholderFragment(input.oldText)) {
    return failStr(
      'anchor contains an omitted-bytes placeholder from read_stage; it does not exist in the stored value — choose an anchor outside omitted regions',
    );
  }
  if (containsReadSceneMediaPlaceholder(input.newText)) {
    return failStr(READ_PLACEHOLDER_REJECTION);
  }
  let occurrences = 0;
  let fromIndex = 0;
  for (;;) {
    const found = current.indexOf(input.oldText, fromIndex);
    if (found < 0) break;
    occurrences += 1;
    fromIndex = found + input.oldText.length;
  }
  if (occurrences === 0) {
    return failStr(
      `anchor text not found in ${input.path} (0 occurrences)${anchorNotFoundHint(current, input.oldText)}`,
    );
  }
  if (!input.replaceAll && occurrences > 1) {
    return failStr(`anchor text occurs ${occurrences} times; extend the anchor or set replaceAll`);
  }
  const replaced = input.replaceAll
    ? current.split(input.oldText).join(input.newText)
    : current.replace(input.oldText, input.newText);
  Object.defineProperty(parent, key, {
    value: replaced,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return { ok: true, value: next, occurrences };
}

function elementIdentityIssue(before: SlideContent, after: SlideContent): string | null {
  if (before.canvas.id !== after.canvas.id) return 'patch cannot change canvas id';
  const oldTypes = new Map(before.canvas.elements.map((element) => [element.id, element.type]));
  const nextIds = after.canvas.elements.map((element) => element.id);
  const duplicates = nextIds.filter((id, index) => nextIds.indexOf(id) !== index);
  if (duplicates.length > 0) {
    return `patch produced duplicate element ids: ${[...new Set(duplicates)].map((id) => JSON.stringify(id)).join(', ')}`;
  }
  const nextSet = new Set(nextIds);
  const added = nextIds.filter((id) => !oldTypes.has(id));
  const removed = [...oldTypes.keys()].filter((id) => !nextSet.has(id));
  if (added.length > 0 || removed.length > 0) {
    const names = (ids: unknown[]) =>
      ids.map((id) => (typeof id === 'string' ? JSON.stringify(id) : '(no id)')).join(', ');
    const changes = [
      ...(added.length ? [`added ${names(added)}`] : []),
      ...(removed.length ? [`removed ${names(removed)}`] : []),
    ];
    return `patch cannot add, remove, or change element ids (${changes.join('; ')}); use add_element/delete_element`;
  }
  for (const element of after.canvas.elements) {
    if (oldTypes.get(element.id) !== element.type) {
      return `patch cannot change type for element ${element.id}`;
    }
  }
  return null;
}

/**
 * Element ids are server-owned. A whole-element `set` of the same type that
 * omits the id still means "replace this element", so it keeps the original
 * id. Carrying ANOTHER existing element's id is a reorder attempt, which
 * `set` cannot express without retargeting animations and actions.
 */
function keepElementIdentity(
  content: SlideContent,
  tokens: string[],
  action: 'set' | 'remove',
  value: unknown,
): ApplyResult<unknown> {
  if (action !== 'set' || !isRecord(value) || tokens.length !== 3) return ok(value);
  if (tokens[0] !== 'canvas' || tokens[1] !== 'elements' || !/^(0|[1-9]\d*)$/.test(tokens[2]!)) {
    return ok(value);
  }
  const index = Number(tokens[2]);
  const existing = content.canvas.elements[index];
  if (!existing) return ok(value);
  if (value.id === undefined) {
    return ok(value.type === existing.type ? { ...value, id: existing.id } : value);
  }
  const other = content.canvas.elements.findIndex(
    (element, at) => at !== index && element.id === value.id,
  );
  if (other >= 0) {
    return fail(
      `set /canvas/elements/${index} carries id ${JSON.stringify(value.id)} of the element at index ${other}; elements cannot be reordered or swapped with set. Edit each element's fields in place, or use delete_element + add_element (afterId/index) to move one`,
    );
  }
  return ok(value);
}

/**
 * Fill structural renderer defaults (`normalizeElement`'s required-field
 * defaults and `rotate: 0`) on a new element before validation. Visible text
 * bodies are never invented: a missing `content` is still reported.
 */
function withRendererDefaults(element: Record<string, unknown>): Record<string, unknown> {
  let normalized: Record<string, unknown>;
  try {
    normalized = normalizeElement(element) as unknown as Record<string, unknown>;
  } catch {
    // Malformed input: let the schema validation report the precise issue.
    return element;
  }
  if (element.type === 'text' && !('content' in element)) delete normalized.content;
  if (isRecord(element.text) && !('content' in element.text) && isRecord(normalized.text)) {
    delete normalized.text.content;
  }
  // Shape geometry is derived from the box only when BOTH halves are absent:
  // a supplied path is in its own coordinate space, so a box-sized viewBox
  // (or a box-sized path for a supplied viewBox) would mis-scale it.
  if (element.type === 'shape' && 'path' in element !== 'viewBox' in element) {
    if (!('path' in element)) delete normalized.path;
    if (!('viewBox' in element)) delete normalized.viewBox;
  }
  if (element.type !== 'line' && !('rotate' in element)) normalized.rotate = 0;
  return normalized;
}

function applyJsonPointerPatch(
  content: SlideContent,
  input: Extract<SlideEditOp, { op: 'patch' }>,
): ApplyResult<SlideContent> {
  if (!input.path.startsWith('/canvas/')) {
    return fail(
      'slide patch path must start with /canvas/ after removing the scene /content prefix',
    );
  }
  if (input.action === 'set' && input.value === undefined) {
    return fail('patch set needs value (use action:"remove" to delete an optional field)');
  }
  if (input.action === 'remove' && input.value !== undefined) {
    return fail('patch remove must not include value');
  }
  if (input.action === 'set' && containsReadSceneMediaPlaceholder(input.value)) {
    return fail(READ_PLACEHOLDER_REJECTION);
  }
  const decoded = decodePointer(input.path);
  if (!decoded.ok) return decoded;
  const value = keepElementIdentity(content, decoded.value, input.action, input.value);
  if (!value.ok) return value;
  const next = structuredClone(content);
  const applied = applyPointer(
    next as unknown as Record<string, unknown>,
    decoded.value,
    input.action,
    value.value,
  );
  if (!applied.ok) return applied;
  return finalizeSlideContent(content, next);
}

/**
 * Shared post-condition for any edit of slide content that keeps element
 * identity (JSON Pointer set/remove, str_replace): ids and types unchanged,
 * no NEW schema violations relative to `before`, and changed LaTeX re-rendered.
 * `after` is mutated (LaTeX html) and returned.
 */
export function finalizeSlideContent(
  before: SlideContent,
  after: SlideContent,
): ApplyResult<SlideContent> {
  const identityIssue = elementIdentityIssue(before, after);
  if (identityIssue) return fail(`patch rejected: ${identityIssue}`);
  const schemaIssues = validateSlideCanvas(after.canvas, before.canvas);
  if (schemaIssues.length > 0) return fail(`patch rejected: ${schemaIssues.join('; ')}`);
  const beforeLatex = new Map(
    before.canvas.elements
      .filter((element) => element.type === 'latex')
      .map((element) => [element.id, element.latex]),
  );
  for (const element of after.canvas.elements) {
    if (element.type !== 'latex' || beforeLatex.get(element.id) === element.latex) continue;
    const html = renderLatexElementHtml(element.latex);
    if (html !== null) element.html = html;
    else delete element.html;
  }
  return ok(after);
}

export function applySlideEdit(
  content: SlideContent,
  input: SlideEditOp,
): ApplyResult<SlideContent> {
  switch (input.op) {
    case 'patch':
      return applyJsonPointerPatch(content, input);
    case 'add_element': {
      if (!isRecord(input.element)) return fail('add_element needs element as an object');
      if ('id' in input.element) {
        return fail(
          'add_element element must not include id (the server assigns element identity)',
        );
      }
      const candidate = withRendererDefaults(input.element);
      const issues = validateElementInput(candidate);
      if (issues.length > 0) return fail(`add_element rejected: ${issues.join('; ')}`);
      if (input.afterId !== undefined && input.index !== undefined) {
        return fail('add_element accepts either afterId or index, not both');
      }
      let index: number | undefined;
      if (input.afterId !== undefined) {
        const afterIndex = content.canvas.elements.findIndex((item) => item.id === input.afterId);
        if (afterIndex < 0) return fail(`no element ${input.afterId}`);
        index = afterIndex + 1;
      } else if (input.index !== undefined) {
        if (
          !Number.isInteger(input.index) ||
          input.index < 0 ||
          input.index > content.canvas.elements.length
        ) {
          return fail(
            `add_element index must be an integer from 0 to ${content.canvas.elements.length}`,
          );
        }
        index = input.index;
      }
      let id = `el-${nanoid(8)}`;
      while (findElement(content, id)) id = `el-${nanoid(8)}`;
      const element = { ...structuredClone(candidate), id } as unknown as PPTElement;
      const next = structuredClone(content);
      next.canvas.elements.splice(index ?? next.canvas.elements.length, 0, element);
      return ok(next);
    }
    case 'delete_element': {
      if (!findElement(content, input.elementId)) return fail(`no element ${input.elementId}`);
      const next = structuredClone(content);
      next.canvas.elements = next.canvas.elements.filter(
        (element) => element.id !== input.elementId,
      );
      return ok(next);
    }
    default:
      return fail(`unknown slide op`);
  }
}

function emptyPblThread(roleId: string): PBLProjectV2['threads'][number] {
  return { agentId: roleId, messages: [] };
}

export function createStubProjectV2(title: string, description = ''): PBLProjectV2 {
  const roleId = `role-${nanoid(8)}`;
  const now = new Date().toISOString();
  return {
    uiPhase: 'hero',
    title,
    description,
    proficiency: '',
    language: 'zh-CN',
    tags: [],
    status: 'designing',
    roles: [{ id: roleId, type: 'instructor', name: 'Instructor' }],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [emptyPblThread(roleId)],
    engagementEvents: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function emptySlideContent(): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: `slide-${nanoid(8)}`,
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#2563eb'],
        fontColor: '#111827',
        fontName: 'Inter',
      },
      elements: [],
    },
  };
}

export function emptyQuizContent(): QuizContent {
  return { type: 'quiz', questions: [] };
}

export function createBlankScene(input: {
  id: string;
  stageId: string;
  order: number;
  title: string;
  type: 'slide' | 'quiz' | 'interactive' | 'pbl';
}): Scene {
  if (input.type === 'quiz') {
    return {
      id: input.id,
      stageId: input.stageId,
      order: input.order,
      title: input.title,
      type: 'quiz',
      content: emptyQuizContent(),
      actions: [],
    } as Scene;
  }
  if (input.type === 'interactive') {
    return {
      id: input.id,
      stageId: input.stageId,
      order: input.order,
      title: input.title,
      type: 'interactive',
      content: { type: 'interactive', url: '', html: '<!DOCTYPE html><html><body></body></html>' },
      actions: [],
    } as Scene;
  }
  if (input.type === 'pbl') {
    const project = createStubProjectV2(input.title);
    return {
      id: input.id,
      stageId: input.stageId,
      order: input.order,
      title: input.title,
      type: 'pbl',
      content: {
        type: 'pbl',
        projectV2: project,
      },
      actions: [],
    } as Scene;
  }
  return {
    id: input.id,
    stageId: input.stageId,
    order: input.order,
    title: input.title,
    type: 'slide',
    content: emptySlideContent(),
    actions: [],
  } as Scene;
}

export function inventoryScene(scene: Scene) {
  const content = scene.content as {
    type?: string;
    questions?: { id: string; question: string; type: string; options?: { label: string }[] }[];
    widgetType?: string;
    widgetConfig?: WidgetConfig;
    html?: string;
    projectV2?: PBLProjectV2;
  };
  // Shallow-copy each action so read_stage surfaces every writable field
  // (spotlight elementId/dimOpacity, speech text/voice/speed/audioId, wb_*
  // geometry, discussion topic, widget state, ...) instead of an id/type/text
  // projection — the agent verifies persisted edits through this inventory.
  const actions = ((scene.actions ?? []) as Action[]).map((action) => ({ ...action }));
  if (content.type === 'slide') {
    return {
      sceneId: scene.id,
      order: scene.order,
      title: scene.title,
      type: 'slide',
      elements: inventorySlide(scene.content as SlideContent),
      actions,
    };
  }
  if (content.type === 'quiz') {
    return {
      sceneId: scene.id,
      order: scene.order,
      title: scene.title,
      type: 'quiz',
      questions: (content.questions ?? []).map((q) => ({
        id: q.id,
        type: q.type,
        question: q.question,
        options: q.options?.map((o) => o.label) ?? [],
      })),
      actions,
    };
  }
  if (content.type === 'interactive') {
    return {
      sceneId: scene.id,
      order: scene.order,
      title: scene.title,
      type: 'interactive',
      widgetType: content.widgetType ?? content.widgetConfig?.type,
      widgetConfig: content.widgetConfig ?? null,
      htmlChars: content.html?.length ?? 0,
      actions,
    };
  }
  if (content.type === 'pbl') {
    const project = content.projectV2;
    return {
      sceneId: scene.id,
      order: scene.order,
      title: scene.title,
      type: 'pbl',
      project: project
        ? {
            title: project.title,
            description: project.description,
            roles: project.roles.map((role: PBLRole) => ({
              id: role.id,
              type: role.type,
              name: role.name,
            })),
            milestones: project.milestones.map((ms) => ({
              id: ms.id,
              title: ms.title,
              microtasks: ms.microtasks.map((mt) => ({ id: mt.id, title: mt.title })),
            })),
          }
        : null,
      actions,
    };
  }
  return {
    sceneId: scene.id,
    order: scene.order,
    title: scene.title,
    type: scene.type,
    actions,
  };
}
