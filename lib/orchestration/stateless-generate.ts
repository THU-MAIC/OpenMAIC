/**
 * Stateless Multi-Agent Generation
 *
 * Single-pass generation with structured JSON Array output format:
 * [{"type":"action","name":"...","params":{...}},{"type":"text","content":"natural speech"},...]
 *
 * Key design decisions:
 * - Backend is stateless (all state in request/response)
 * - Single generation pass (no generate/tool/loop)
 * - Text is natural teacher speech, NOT meta-commentary
 * - Tool calls are silent actions - students see results only
 * - Action and text objects can freely interleave in the array
 * - Uses partial-json for robust streaming of incomplete JSON
 *
 * Multi-agent orchestration:
 * - When multiple agents are configured, a director agent decides who speaks
 * - Uses LangGraph StateGraph for the orchestration loop
 * - Events are streamed via LangGraph's custom stream mode
 */

import type { LanguageModel } from 'ai';
import type { StatelessChatRequest, StatelessEvent, ParsedAction } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import type { WhiteboardActionRecord } from './types';
import { createOrchestrationGraph, buildInitialState } from './director-graph';
import { parse as parsePartialJson, Allow } from 'partial-json';
import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';

const log = createLogger('StatelessGenerate');

// ==================== Structured Output Parser ====================

/**
 * Parser state for incremental JSON Array parsing.
 *
 * Accumulates raw text from the LLM stream. Once the opening `[` is found,
 * uses `partial-json` to incrementally parse the growing array. Emits new
 * complete items as they appear, and streams partial text content deltas
 * for the last (potentially incomplete) text item.
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

/**
 * Emit a single parsed item into the result, returning updated segment indices.
 */
function emitItem(
  item: Record<string, unknown>,
  result: ParseResult,
  textSegmentIndex: number,
  actionSegmentIndex: number,
): { textSegmentIndex: number; actionSegmentIndex: number } {
  if (item.type === 'text') {
    const content = (item.content as string) || '';
    if (content) {
      result.textChunks.push(content);
      // Use per-call array index (not cumulative segment index) so that
      // director-graph can read result.textChunks[entry.index] correctly.
      result.ordered.push({
        type: 'text',
        index: result.textChunks.length - 1,
      });
      return { textSegmentIndex: textSegmentIndex + 1, actionSegmentIndex };
    }
  } else if (item.type === 'action') {
    // Support both new format (name/params) and legacy format (tool_name/parameters)
    const action: ParsedAction = {
      actionId:
        (item.action_id as string) || `action-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      actionName: (item.name || item.tool_name) as string,
      params: (item.params || item.parameters || {}) as Record<string, unknown>,
    };
    result.actions.push(action);
    // Use per-call array index (not cumulative segment index) so that
    // director-graph can read result.actions[entry.index] correctly.
    result.ordered.push({ type: 'action', index: result.actions.length - 1 });
    return { textSegmentIndex, actionSegmentIndex: actionSegmentIndex + 1 };
  }
  return { textSegmentIndex, actionSegmentIndex };
}

/**
 * Parse streaming chunks of structured JSON Array output.
 *
 * The LLM is expected to produce a JSON array like:
 * [{"type":"action","name":"spotlight","params":{"elementId":"img_1"}},
 *  {"type":"text","content":"Hello students..."},...]
 *
 * This parser:
 * 1. Accumulates chunks into a buffer
 * 2. Skips any prefix before `[` (e.g. ```json\n, explanatory text)
 * 3. Uses partial-json to incrementally parse the growing array
 * 4. Emits new complete items (action→toolCall, text→textChunk)
 * 5. For the trailing incomplete text item, emits content deltas for streaming
 * 6. Marks done when the buffer contains the closing `]`
 *
 * @param chunk - New chunk of text to parse
 * @param state - Current parser state (mutated in place)
 * @returns Parsed text chunks and tool calls from this chunk
 */
export function parseStructuredChunk(chunk: string, state: ParserState): ParseResult {
  const result: ParseResult = {
    textChunks: [],
    actions: [],
    isDone: false,
    ordered: [],
  };

  if (state.isDone) {
    return result;
  }

  state.buffer += chunk;

  // Step 1: Find the opening `[` if not yet found
  if (!state.jsonStarted) {
    const bracketIndex = state.buffer.indexOf('[');
    if (bracketIndex === -1) {
      return result;
    }
    // Trim everything before `[` (markdown fences, explanatory text, etc.)
    state.buffer = state.buffer.slice(bracketIndex);
    state.jsonStarted = true;
  }

  // Step 2: Check if the array is complete (closing `]` found)
  const trimmed = state.buffer.trimEnd();
  const isArrayClosed = trimmed.endsWith(']') && trimmed.length > 1;

  // Step 3: Try incremental parse — jsonrepair first (fixes unescaped quotes), fallback to partial-json
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial-json returns any[]
  let parsed: any[];
  try {
    const repaired = jsonrepair(state.buffer);
    parsed = JSON.parse(repaired);
  } catch {
    try {
      parsed = parsePartialJson(
        state.buffer,
        Allow.ARR | Allow.OBJ | Allow.STR | Allow.NUM | Allow.BOOL | Allow.NULL,
      );
    } catch {
      return result;
    }
  }

  if (!Array.isArray(parsed)) {
    return result;
  }

  // Step 4: Determine how many items are fully complete
  // When the array is closed, all items are complete.
  // When still streaming, items [0..N-2] are complete; item [N-1] may be partial.
  const completeUpTo = isArrayClosed ? parsed.length : Math.max(0, parsed.length - 1);

  // Count segment indices for items already emitted
  let textSegmentIndex = 0;
  let actionSegmentIndex = 0;
  for (let i = 0; i < state.lastParsedItemCount && i < parsed.length; i++) {
    const item = parsed[i];
    if (item?.type === 'text') textSegmentIndex++;
    else if (item?.type === 'action') actionSegmentIndex++;
  }

  // Step 5: Emit newly completed items
  for (let i = state.lastParsedItemCount; i < completeUpTo; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object') continue;

    // If this item was previously the trailing partial text item, we've already
    // streamed its content incrementally. Only emit the remaining delta, not the full content.
    if (
      i === state.lastParsedItemCount &&
      state.lastPartialTextLength > 0 &&
      item.type === 'text'
    ) {
      const content = item.content || '';
      const remaining = content.slice(state.lastPartialTextLength);
      if (remaining) {
        result.textChunks.push(remaining);
        // Only push ordered entry when there is actual content to emit
        result.ordered.push({
          type: 'text',
          index: result.textChunks.length - 1,
        });
      }
      textSegmentIndex++;
      state.lastPartialTextLength = 0;
      continue;
    }

    const indices = emitItem(item, result, textSegmentIndex, actionSegmentIndex);
    textSegmentIndex = indices.textSegmentIndex;
    actionSegmentIndex = indices.actionSegmentIndex;
  }

  state.lastParsedItemCount = completeUpTo;

  // Step 6: Stream partial text delta for the trailing item
  if (!isArrayClosed && parsed.length > completeUpTo) {
    const lastItem = parsed[parsed.length - 1];
    if (lastItem && typeof lastItem === 'object' && lastItem.type === 'text') {
      const content = lastItem.content || '';
      if (content.length > state.lastPartialTextLength) {
        result.textChunks.push(content.slice(state.lastPartialTextLength));
        state.lastPartialTextLength = content.length;
      }
    }
  }

  // Step 7: Mark done if array is closed
  if (isArrayClosed) {
    state.isDone = true;
    result.isDone = true;
    state.lastParsedItemCount = parsed.length;
    state.lastPartialTextLength = 0;
  }

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
    } else if (!looksLikeStructuredFragment(content)) {
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
    const finalChunk = parseStructuredChunk('', state);
    result.textChunks.push(...finalChunk.textChunks);
    result.actions.push(...finalChunk.actions);
    result.ordered.push(...finalChunk.ordered);
  }

  state.isDone = true;
  return result;
}

// ==================== Main Generation Function ====================

/**
 * Stateless generation with streaming via LangGraph orchestration
 *
 * @param request - The chat request with full state
 * @param abortSignal - Signal for cancellation
 * @yields StatelessEvent objects for streaming
 */
export async function* statelessGenerate(
  request: StatelessChatRequest,
  abortSignal: AbortSignal,
  languageModel: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): AsyncGenerator<StatelessEvent> {
  log.info(
    `[StatelessGenerate] Starting orchestration for agents: ${request.config.agentIds.join(', ')}`,
  );
  log.info(
    `[StatelessGenerate] Message count: ${request.messages.length}, turnCount: ${request.directorState?.turnCount ?? 0}`,
  );

  try {
    const graph = createOrchestrationGraph();
    const initialState = buildInitialState(request, languageModel, thinkingConfig);

    const stream = await graph.stream(initialState, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamMode: 'custom' as any,
      signal: abortSignal,
    });

    let totalActions = 0;
    let totalAgents = 0;
    // Tracks whether the agent dispatched in this turn produced any text or actions.
    // Each statelessGenerate call handles exactly one agent turn (client loops externally).
    let agentHadContent = false;

    // Track current agent turn to build updated directorState
    let currentAgentId: string | null = null;
    let currentAgentName: string | null = null;
    let contentPreview = '';
    let agentActionCount = 0;
    const agentWbActions: WhiteboardActionRecord[] = [];

    for await (const chunk of stream) {
      const event = chunk as StatelessEvent;

      if (event.type === 'agent_start') {
        totalAgents++;
        currentAgentId = event.data.agentId;
        currentAgentName = event.data.agentName;
        contentPreview = '';
        agentActionCount = 0;
        agentWbActions.length = 0;
      }
      if (event.type === 'text_delta' && contentPreview.length < 100) {
        contentPreview = (contentPreview + event.data.content).slice(0, 100);
        agentHadContent = true;
      }
      if (event.type === 'action') {
        totalActions++;
        agentActionCount++;
        agentHadContent = true;
        if (event.data.actionName.startsWith('wb_')) {
          agentWbActions.push({
            actionName: event.data.actionName as WhiteboardActionRecord['actionName'],
            agentId: event.data.agentId,
            agentName: currentAgentName || event.data.agentId,
            params: event.data.params,
          });
        }
      }

      yield event;
    }

    // Build updated directorState from incoming state + this turn's data
    const incoming = request.directorState;
    const prevResponses = incoming?.agentResponses ?? [];
    const prevLedger = incoming?.whiteboardLedger ?? [];
    const prevTurnCount = incoming?.turnCount ?? 0;

    const directorState =
      totalAgents > 0
        ? {
            turnCount: prevTurnCount + 1,
            agentResponses: [
              ...prevResponses,
              {
                agentId: currentAgentId!,
                agentName: currentAgentName || currentAgentId!,
                contentPreview,
                actionCount: agentActionCount,
                whiteboardActions: [...agentWbActions],
              },
            ],
            whiteboardLedger: [...prevLedger, ...agentWbActions],
          }
        : {
            turnCount: prevTurnCount,
            agentResponses: prevResponses,
            whiteboardLedger: prevLedger,
          };

    yield {
      type: 'done',
      data: { totalActions, totalAgents, agentHadContent, directorState },
    };

    log.info(
      `[StatelessGenerate] Completed. Agents: ${totalAgents}, Actions: ${totalActions}, hadContent: ${agentHadContent}, turnCount: ${directorState.turnCount}`,
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      yield { type: 'error', data: { message: 'Request interrupted' } };
    } else {
      log.error('[StatelessGenerate] Error:', error);
      yield {
        type: 'error',
        data: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
