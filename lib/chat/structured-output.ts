/**
 * Structured Output Parser
 *
 * Incremental parser for the structured JSON Array output format:
 * [{"type":"action","name":"...","params":{...}},{"type":"text","content":"natural speech"},...]
 *
 * Action and text objects can freely interleave in the array. Uses
 * partial-json for robust streaming of incomplete JSON.
 */

import type { ParsedAction } from '@/lib/types/chat';
import { parse as parsePartialJson, Allow } from 'partial-json';
import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';

const log = createLogger('StructuredOutput');

/**
 * Parser state for incremental JSON Array parsing.
 *
 * Tracks completed array items and the text already streamed from the current item.
 */
interface ParserState {
  /** Accumulated raw text from the LLM */
  buffer: string;
  /** Whether we've found the opening `[` */
  jsonStarted: boolean;
  /** Number of fully processed (emitted) items */
  lastParsedItemCount: number;
  /** Length of text content already emitted for the trailing partial text item */
  lastPartialTextLength: number;
  /** Whether parsing is complete (closing `]` found) */
  isDone: boolean;
}

/**
 * Create initial parser state
 */
export function createParserState(): ParserState {
  return {
    buffer: '',
    jsonStarted: false,
    lastParsedItemCount: 0,
    lastPartialTextLength: 0,
    isDone: false,
  };
}

/**
 * Result from parsing a chunk
 */
export interface ParseResult {
  textChunks: string[];
  actions: ParsedAction[];
  isDone: boolean;
  /** Ordered sequence recording original interleaving of text and action segments */
  ordered: Array<{ type: 'text'; index: number } | { type: 'action'; index: number }>;
}

function pushText(result: ParseResult, content: string) {
  if (!content) return;
  result.textChunks.push(content);
  result.ordered.push({ type: 'text', index: result.textChunks.length - 1 });
}

const STRUCTURED_ITEM_OPENINGS = ['[{"type":"text"', '[{"type":"action"'];

function findArrayStart(buffer: string, allowIncompleteType = false): number {
  const leading = /^\s*(?:```(?:json)?\s*)?\[\s*(?=[{\]])/i.exec(buffer);
  if (leading) return leading[0].indexOf('[');

  // With an explanatory prefix, require a classroom item so bracketed prose
  // and unrelated array examples stay on the plain-text path.
  const openings = /\[\s*(?=\{)/g;
  for (let opening = openings.exec(buffer); opening; opening = openings.exec(buffer)) {
    if (allowIncompleteType) {
      // At EOF only, a tail that stops before the type value is complete
      // (`[{`, `[{"ty`, `[{"type":`) is an unfinished classroom item.
      const tail = buffer.slice(opening.index).replace(/\s+/g, '');
      if (STRUCTURED_ITEM_OPENINGS.some((itemOpening) => itemOpening.startsWith(tail))) {
        return opening.index;
      }
    }
    try {
      const items = parsePartialJson(buffer.slice(opening.index), Allow.ARR | Allow.OBJ);
      if (
        items.some(
          (item: { type?: string } | null) => item?.type === 'text' || item?.type === 'action',
        )
      ) {
        return opening.index;
      }
      if (allowIncompleteType) {
        // At EOF only, recognize a type string that was omitted above because
        // it is unfinished. Complete unrelated type values remain plain prose.
        const partialItems = parsePartialJson(
          buffer.slice(opening.index),
          Allow.ARR | Allow.OBJ | Allow.STR,
        );
        if (
          partialItems.some(
            (item: { type?: string } | null, index: number) =>
              typeof item?.type === 'string' &&
              items[index]?.type === undefined &&
              ('text'.startsWith(item.type) || 'action'.startsWith(item.type)),
          )
        ) {
          return opening.index;
        }
      }
    } catch {
      // The discriminator may still be arriving.
    }
  }
  return -1;
}

function scanArray(buffer: string): { items: string[]; trailing: string; closed: boolean } {
  const items: string[] = [];
  let start = 1;
  let depth = 1;
  let inString = false;
  let escaped = false;

  for (let index = start; index < buffer.length; index++) {
    const char = buffer[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (depth === 1 && (char === ',' || char === ']')) {
      const item = buffer.slice(start, index).trim();
      if (item) items.push(item);
      if (char === ']') return { items, trailing: '', closed: true };
      start = index + 1;
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      depth++;
    } else if (char === ']' || char === '}') {
      depth--;
    }
  }

  return { items, trailing: buffer.slice(start).trimStart(), closed: false };
}

function parseCompleteItem(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown> | null;
  } catch {
    try {
      // Recover speech with unescaped quotes without creating an action.
      const repaired = JSON.parse(jsonrepair(raw)) as Record<string, unknown> | null;
      return repaired?.type === 'text' ? repaired : null;
    } catch {
      try {
        // A false boundary inside malformed speech can leave an unrepaired
        // fragment. Preserve only its readable text prefix, never an action.
        const partial = parsePartialJson(
          raw,
          Allow.ARR | Allow.OBJ | Allow.STR | Allow.NUM | Allow.BOOL | Allow.NULL,
        );
        return partial?.type === 'text' ? partial : null;
      } catch {
        return null;
      }
    }
  }
}

function repairPendingTextArray(trailing: string): string | null {
  const raw = `[${trailing.replace(/\s*```\s*$/, '').trimEnd()}`;
  if (!raw.endsWith(']')) return null;

  try {
    const repaired = jsonrepair(raw);
    const { items, closed } = scanArray(repaired);
    const first = items[0];
    if (!closed || !first || JSON.parse(first)?.type !== 'text') return null;

    // Allow quote escapes in the pending text item only. The rest of the
    // array must already be present verbatim, including any action delimiters.
    const suffix = repaired.slice(1 + first.length);
    if (!raw.endsWith(suffix)) return null;
    const original = raw.slice(1, raw.length - suffix.length);
    return original.replaceAll(/\\"/g, '"') === first.replaceAll(/\\"/g, '"') ? repaired : null;
  } catch {
    return null;
  }
}

/** Stream text deltas and emit complete items in their original order. */
export function parseStructuredChunk(chunk: string, state: ParserState): ParseResult {
  const result: ParseResult = { textChunks: [], actions: [], isDone: false, ordered: [] };
  if (state.isDone) return result;

  state.buffer += chunk;
  if (!state.jsonStarted) {
    const start = findArrayStart(state.buffer);
    if (start === -1) return result;
    state.buffer = state.buffer.slice(start);
    state.jsonStarted = true;
  }

  const { items, trailing, closed } = scanArray(state.buffer);
  for (let index = state.lastParsedItemCount; index < items.length; index++) {
    const item = parseCompleteItem(items[index]);
    if (item?.type === 'text' && typeof item.content === 'string') {
      pushText(result, item.content.slice(state.lastPartialTextLength));
    } else if (item?.type === 'action') {
      result.actions.push({
        actionId:
          (item.action_id as string) ||
          `action-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        actionName: (item.name || item.tool_name) as string,
        params: (item.params || item.parameters || {}) as Record<string, unknown>,
      });
      result.ordered.push({ type: 'action', index: result.actions.length - 1 });
    }
    state.lastPartialTextLength = 0;
  }
  state.lastParsedItemCount = items.length;

  if (!closed && trailing) {
    try {
      const item = parsePartialJson(
        trailing,
        Allow.ARR | Allow.OBJ | Allow.STR | Allow.NUM | Allow.BOOL | Allow.NULL,
      );
      if (item?.type === 'text' && typeof item.content === 'string') {
        pushText(result, item.content.slice(state.lastPartialTextLength));
        state.lastPartialTextLength = Math.max(state.lastPartialTextLength, item.content.length);
      }
    } catch {
      // A partial escape or property may need more input.
    }
  }

  state.isDone = closed;
  result.isDone = closed;
  return result;
}

/**
 * Detect a leftover buffer that is structured-output residue rather than
 * natural speech — a bare object/array, or a brace-less fragment like
 * `type":"text","content":"..."` left behind when the model's JSON is
 * truncated. Used as a fail-safe so such residue is suppressed, never shown
 * as visible speech.
 */
export function looksLikeStructuredFragment(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  // The structured-output schema signature: a `type` discriminator, or one of
  // the well-known keys as a JSON property, appearing at the START of the
  // buffer. Anchoring to the start is deliberate: it still catches residue and
  // brace-less truncated tails like `type":"text","content":"...`, but does NOT
  // fire on natural speech that merely mentions a JSON example mid-sentence,
  // e.g. `我们用对象 {"name":"树"} 表示一棵树。` — which must stay visible.
  const hasSchemaKey =
    /^"?type"?\s*:\s*"(text|action)"/.test(trimmed) ||
    /^"(content|name|params|action_id)"\s*:/.test(trimmed);
  if (hasSchemaKey) return true;
  // A bare `{`/`[` opener counts only when it is immediately structural
  // (another opener, a quoted key, a closer, or end-of-string) — NOT any
  // sentence that merely starts with a bracket, e.g. "[重点] ..." or set
  // notation "{x | x > 0}".
  return /^[[{]\s*([[{"\]}]|$)/.test(trimmed);
}

/**
 * When the model emits a bare structured object/array instead of the required
 * top-level array, extract visible text from well-formed `{type:'text'}` items.
 * Requires a strict parse: a malformed object (one that would need repair), or
 * an action/unknown-typed object, yields no text so the caller suppresses it
 * rather than leaking raw JSON.
 */
function extractCleanStructuredText(raw: string): { matched: boolean; texts: string[] } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { matched: false, texts: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { matched: false, texts: [] };
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const allTyped = items.every(
    (item) => item && typeof item === 'object' && 'type' in (item as object),
  );
  if (!allTyped) {
    return { matched: false, texts: [] };
  }
  const texts: string[] = [];
  for (const item of items) {
    const obj = item as Record<string, unknown>;
    if (obj.type === 'text' && typeof obj.content === 'string' && obj.content.trim()) {
      texts.push(obj.content);
    }
  }
  return { matched: true, texts };
}

/**
 * Finalize parsing after the stream ends.
 *
 * Handles the case where the model never produced a valid JSON array. Rather
 * than dumping the raw buffer (which leaks `{"type":"text",...}` into the
 * chat bubble), we structurally recover visible text where possible and
 * suppress anything that is still structured-output residue.
 */
export function finalizeParser(state: ParserState): ParseResult {
  const result: ParseResult = {
    textChunks: [],
    actions: [],
    isDone: true,
    ordered: [],
  };

  if (state.isDone) {
    return result;
  }

  const content = state.buffer.trim();
  if (!content) {
    state.isDone = true;
    return result;
  }

  const pushText = (value: string) => {
    if (!value) return;
    result.textChunks.push(value);
    result.ordered.push({ type: 'text', index: result.textChunks.length - 1 });
  };

  if (!state.jsonStarted) {
    // Model never emitted the required top-level `[`. It may have produced a
    // bare structured object, a truncated JSON fragment, or genuine prose.
    const structured = extractCleanStructuredText(content);
    if (structured.matched) {
      // Bare `{type:'text'}` (or array of them) → show content; action/unknown → suppress.
      structured.texts.forEach(pushText);
    } else if (!looksLikeStructuredFragment(content) && findArrayStart(content, true) === -1) {
      // Genuine plain prose — display it.
      pushText(content);
    } else {
      // JSON-ish fragment that did not parse cleanly → suppress (never leak raw
      // JSON). Log so this path stays observable instead of silently dropping.
      log.debug(
        `[finalizeParser] Suppressed structured-output residue (${content.length} chars): ${content.slice(0, 80)}`,
      );
    }
  } else {
    // JSON array started but never closed — flush whatever the incremental
    // parser can still recover. Intentionally NO raw-buffer fallback:
    // suppressing a truncated structured tail is safer than leaking
    // `{"type":"text",...` as visible speech.
    const repaired = repairPendingTextArray(scanArray(state.buffer).trailing);
    const finalChunk = repaired
      ? parseStructuredChunk(repaired, { ...state, buffer: '', lastParsedItemCount: 0 })
      : parseStructuredChunk('', state);
    result.textChunks.push(...finalChunk.textChunks);
    result.actions.push(...finalChunk.actions);
    result.ordered.push(...finalChunk.ordered);
  }

  state.isDone = true;
  return result;
}
