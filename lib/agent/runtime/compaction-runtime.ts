/**
 * Pi-native conversation compaction runtime.
 *
 * pi's compaction machinery (dist/harness/compaction: prepareCompaction
 * / compact / shouldCompact / generateSummary) is NOT invoked by the core
 * `Agent` on its own. The supported hook is the `transformContext` constructor
 * option: the agent loop calls it before every LLM stream (agent-loop's
 * streamAssistantResponse), lets it swap the messages handed to the LLM, and
 * never writes the transformed result back into `agent.state.messages`.
 *
 * This module is that hook. Each call derives the current view from a
 * session tree — the server adapter's already-flushed PG Session, or an
 * ephemeral in-memory tree for stateless callers — and estimates it. Only
 * after the threshold is crossed does it run prepareCompaction → compact (an
 * LLM summarization call) → appendCompaction. The compacted context is a `compactionSummary`
 * custom-role message followed by the kept tail. `convertToLlm` turns the
 * compaction entry into a user message with a "history compacted" preamble;
 * callers MUST pass pi's `convertToLlm` to the Agent alongside this
 * transformContext, otherwise the default convertToLlm filters out the
 * compactionSummary role entirely.
 *
 * Every returned view is also checked against the model's context budget:
 * a request that would still exceed it (compaction disabled, summarization
 * failed, or the compacted view is still too large) raises ContextBudgetError
 * instead of being sent to the provider.
 *
 * The server agent runtime consumes this through a thin adapter
 * (lib/server/agent-runtime/compaction.ts) that supplies the focus
 * instructions and its durable session tree.
 *
 * The summary LLM call rides the SAME StreamFn as the conversation (the
 * connector model's api is bridged into that streamFn), so it inherits the
 * caller's resolved connection — no new model routing is introduced.
 */
import {
  compact,
  convertToLlm,
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummary,
  InMemorySessionRepo,
  Session,
  prepareCompaction,
  serializeConversation,
  shouldCompact,
  type AgentMessage,
  type CompactionPreparation,
  type CompactionSettings,
  type SessionTreeEntry,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { nanoid } from 'nanoid';
import { ContextBudgetError } from './context-budget-error';

/** One successful compaction, for telemetry and traces. */
export interface CompactionEvent {
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  firstKeptEntryId: string;
  summary: string;
  /** Summary model calls this compaction made (chunks + final summary). */
  summaryCalls: number;
}

/**
 * Why a summary call failed, as log-safe metadata. No free-text error message
 * is kept: provider errors can quote the request they rejected.
 */
export interface SummaryFailure {
  errorName: string;
  /** pi's CompactionError code, or the error's own `code`. */
  errorCode?: string;
  /** Stable request-failure code from the model transport, when present. */
  providerCode?: string;
  /** Provider HTTP status, when the error carries one. */
  httpStatus?: string;
  timeoutOrAbort: boolean;
  modelRoute: string;
}

const REQUEST_FAILURE_CODE = /\[(MODEL_REQUEST_[A-Z_]+)\]/;
const HTTP_STATUS = /\b(?:status(?:\s*code)?|HTTP)\s*[:=]?\s*([1-5]\d\d)\b/i;
const TIMEOUT_OR_ABORT =
  /\b(?:abort(?:ed)?|timed\s*out|time\s*out|timeout|ETIMEDOUT)\b|IDLE_TIMEOUT/i;

function primitiveCode(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/**
 * Describe a summary failure without any conversation content: only codes
 * and flags are extracted from the error, never its message text.
 */
export function describeSummaryFailure(
  error: unknown,
  context: { modelRoute: string; aborted?: boolean },
): SummaryFailure {
  const record = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const cause = (record.cause && typeof record.cause === 'object' ? record.cause : {}) as Record<
    string,
    unknown
  >;
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const status =
    primitiveCode(record.status) ??
    primitiveCode(record.statusCode) ??
    primitiveCode(cause.status) ??
    primitiveCode(cause.statusCode) ??
    HTTP_STATUS.exec(raw)?.[1];
  const providerCode = REQUEST_FAILURE_CODE.exec(raw)?.[1];
  const errorName =
    (typeof record.name === 'string' && record.name) ||
    (error instanceof Error ? error.constructor.name : typeof error);
  const errorCode = primitiveCode(record.code);
  return {
    errorName,
    ...(errorCode ? { errorCode } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(status ? { httpStatus: status } : {}),
    timeoutOrAbort:
      context.aborted === true ||
      errorCode === 'aborted' ||
      ['AbortError', 'TimeoutError'].includes(errorName) ||
      TIMEOUT_OR_ABORT.test(raw),
    modelRoute: context.modelRoute,
  };
}

/** Cumulative runtime accounting since creation (survives dispose). */
export interface CompactionTrace {
  enabled: true;
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
  effectiveOutputTokens: number;
  targetTokens: number;
  checkCount: number;
  triggerCount: number;
  /** Summary model calls across all compactions, including chunk calls. */
  summaryCalls: number;
  failures: string[];
  events: CompactionEvent[];
  /** The latest failed summary call, when there was one. */
  lastSummaryFailure?: SummaryFailure;
}

/** The hook surface an Agent consumes; createCompactionRuntime builds it. */
export interface CompactionRuntime {
  transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getTrace: () => CompactionTrace;
  dispose: () => void;
}

export interface CreateCompactionRuntimeOptions {
  streamFn: StreamFn;
  contextWindow?: number;
  maxOutputTokens?: number;
  settings?: Partial<CompactionSettings>;
  /**
   * Identifies this runtime in the connector model id and the registered
   * provider source id (e.g. 'director', 'agent-runtime').
   */
  label: string;
  /** Operator-facing model/route identity used by configuration warnings. */
  modelRouteLabel?: string;
  /** Extra focus instructions appended to the summarization prompt. */
  focusInstructions?: string;
  /** Static request context which transformContext itself does not receive. */
  systemPrompt?: string;
  tools?: readonly unknown[];
  /** Include read-time protocol repairs/preambles in admission before committing a cut. */
  budgetMessages?: (messages: AgentMessage[]) => AgentMessage[];
  /** Called after each successful compaction; keep it synchronous/cheap. */
  onCompaction?: (event: CompactionEvent) => void;
  /** Optional session tree used to derive the current context on every check. */
  compactionSession?: {
    /** Return the caller's complete tree for the supplied Agent state. */
    acquire(messages: AgentMessage[], signal?: AbortSignal): Promise<Session>;
    /** PG history uses failure propagation; request-local memory may degrade. */
    required?: boolean;
  };
}

/**
 * Upper bounds for EXPLICIT reserve/keep overrides, as fractions of the model's
 * context window. Without them an operator-supplied value (or the fixed pi
 * defaults, when a caller passed them verbatim) can break the loop entirely:
 * reserve ≥ window makes `shouldCompact` trigger on every round (threshold
 * ≤ 0), and reserve + keep > window compacts without shrinking.
 * Values at or under the cap are kept as the operator set them.
 */
const MAX_RESERVE_FRACTION = 0.25; // reserve ≤ window / 4
const MAX_KEEP_FRACTION = 0.5; // keep ≤ window / 2
export const MIN_COMPACTION_TARGET_TOKENS = 4_096;

export function resolveCompactionTargetTokens(
  contextWindow: number,
  reserveTokens: number,
  maxOutputTokens: number,
): number {
  const rawTargetTokens = contextWindow - Math.max(reserveTokens, maxOutputTokens);
  return rawTargetTokens > 0
    ? rawTargetTokens
    : Math.min(MIN_COMPACTION_TARGET_TOKENS, contextWindow);
}

/**
 * pi's summarization system prompt and instruction templates are not exported
 * (together about 1,700 characters); this bounds them and the per-request
 * framing from above.
 */
const SUMMARY_PROMPT_OVERHEAD_TOKENS = 512;
/** Most chunk calls one compaction may spend on history too large for one request. */
export const MAX_SUMMARY_CHUNK_CALLS = 8;

/** A summary request that cannot be made to fit the summary model's window. */
export class SummaryInputTooLargeError extends Error {
  constructor(
    public readonly code: 'chunk_limit' | 'message_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'SummaryInputTooLargeError';
  }
}

/** Share of the dynamic (non-static) budget left for the generated summary. */
const SUMMARY_BUDGET_SHARE = 0.25;

/**
 * Re-clamp a retention budget against the provider-safe target. Static
 * system/tool context is paid first; 25% of the remaining dynamic budget is
 * left for the generated summary. Limiting the tail to 75% makes the native
 * cut materially smaller than the target instead of merely changing an
 * inverted `keep === target` into an equally fragile off-by-one boundary.
 *
 * A zero result is intentional when static context already fills the target:
 * pi can still choose the latest legal cut, while emergencyCompact retains
 * the existing explicit error for an intrinsically impossible request.
 */
export function resolveCompactionKeepRecentTokens(
  keepRecentTokens: number,
  targetTokens: number,
  staticContextTokens: number,
): number {
  const dynamicBudget = Math.max(0, targetTokens - staticContextTokens);
  return Math.min(keepRecentTokens, Math.floor(dynamicBudget * (1 - SUMMARY_BUDGET_SHARE)));
}

function clampToWindowFraction(name: string, value: number, cap: number): number {
  if (value > cap) {
    console.warn(
      `[compaction] ${name}=${value} exceeds the window-ratio cap ${cap}; clamping to ${cap}`,
    );
    return cap;
  }
  return value;
}

function resolveSettings(
  contextWindow: number,
  overrides?: Partial<CompactionSettings>,
): CompactionSettings {
  const reserveTokens = Math.min(
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    Math.max(2_048, Math.floor(contextWindow * 0.2)),
  );
  const keepRecentTokens = Math.min(
    DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    Math.max(2_048, Math.floor(contextWindow * 0.25)),
  );
  return {
    enabled: overrides?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens:
      overrides?.reserveTokens !== undefined
        ? clampToWindowFraction(
            'reserveTokens',
            overrides.reserveTokens,
            Math.floor(contextWindow * MAX_RESERVE_FRACTION),
          )
        : reserveTokens,
    keepRecentTokens:
      overrides?.keepRecentTokens !== undefined
        ? clampToWindowFraction(
            'keepRecentTokens',
            overrides.keepRecentTokens,
            Math.floor(contextWindow * MAX_KEEP_FRACTION),
          )
        : keepRecentTokens,
  };
}

function createConnectorModel(
  label: string,
  api: Api,
  contextWindow: number,
  maxTokens: number,
): Model<Api> {
  return {
    id: `maic-${label}-compaction`,
    name: `MAIC ${label} Compaction`,
    api,
    provider: 'maic-connector',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

/**
 * Conservative request estimator used instead of pi's usage-anchor + chars/4
 * heuristic. It serializes message fields (including tool-result `details`)
 * together with the system prompt and tool schemas, budgeting native image
 * content separately rather than counting its encoded bytes. CJK and other
 * non-ASCII code points count as one token each; ASCII keeps the usual 4:1
 * approximation. This is a heuristic, not the provider's exact tokenizer.
 */
// Admission heuristic, not a tokenizer claim. Native preview images
// use a fixed budget independent of their compressed byte size.
export const IMAGE_BLOCK_TOKEN_BUDGET = 2048;
export const IMAGE_PROTOCOL_TOKEN_BUDGET = 64;

export function estimateFullContextTokens(input: {
  messages: readonly AgentMessage[];
  systemPrompt?: string;
  tools?: readonly unknown[];
}): number {
  let serialized: string;
  const imageBlocks = new Set<object>();
  let imageCount = 0;
  for (const message of input.messages) {
    if ('content' in message && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'image') {
          imageBlocks.add(block);
          imageCount += 1;
        }
      }
    }
  }
  try {
    serialized = JSON.stringify(
      {
        systemPrompt: input.systemPrompt ?? '',
        tools: input.tools ?? [],
        messages: input.messages,
      },
      (_key, value: unknown) => {
        if (value && typeof value === 'object' && imageBlocks.has(value)) {
          return { type: 'image' };
        }
        if (typeof value === 'function' || typeof value === 'symbol') return undefined;
        if (typeof value === 'bigint') return value.toString();
        return value;
      },
    );
  } catch {
    // A hostile details payload must cause early compaction, never blindness.
    return Number.MAX_SAFE_INTEGER;
  }
  let ascii = 0;
  let nonAscii = 0;
  for (const char of serialized) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return (
    Math.ceil(ascii / 4 + nonAscii) +
    imageCount * (IMAGE_BLOCK_TOKEN_BUDGET + IMAGE_PROTOCOL_TOKEN_BUDGET)
  );
}

// A runtime is built per model call; report a given configuration clamp once.
const reportedKeepClamps = new Set<string>();

const LOSSY_SUMMARY =
  'Older oversized tool output was omitted by the emergency context compactor. ' +
  'Its durable identifiers and error status were retained; re-read source data if exact output is needed.';
const OMITTED_TEXT = '[Oversized historical content omitted during emergency context compaction.]';

function buildCompactedView(
  branch: SessionTreeEntry[],
  result: { summary: string; firstKeptEntryId: string; tokensBefore: number },
): AgentMessage[] {
  const entry: SessionTreeEntry = {
    type: 'compaction',
    // This entry exists only long enough to estimate the post-compaction view.
    // Durable IDs are allocated solely by Session.appendCompaction below.
    id: '__compaction_view__',
    parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
  };
  const compactionIdx = branch.length;
  const firstKeptIndex = branch.findIndex((candidate) => candidate.id === result.firstKeptEntryId);
  const kept = branch
    .slice(firstKeptIndex, compactionIdx)
    .filter(
      (candidate): candidate is Extract<SessionTreeEntry, { type: 'message' }> =>
        candidate.type === 'message',
    )
    .map((candidate) => candidate.message);
  return [
    createCompactionSummaryMessage(result.summary, result.tokensBefore, entry.timestamp),
    ...kept,
  ];
}

function scrubMessage(message: AgentMessage): AgentMessage {
  const value = message as unknown as Record<string, unknown>;
  switch (message.role) {
    case 'toolResult':
      return {
        role: 'toolResult',
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        content: [{ type: 'text', text: OMITTED_TEXT }],
        isError: value.isError === true,
        timestamp: value.timestamp,
        details: { compacted: true },
      } as unknown as AgentMessage;
    case 'assistant': {
      const content = Array.isArray(value.content)
        ? value.content.map((block) => {
            const item = block as Record<string, unknown>;
            if (item.type === 'toolCall') {
              return { type: 'toolCall', id: item.id, name: item.name, arguments: {} };
            }
            return { type: 'text', text: OMITTED_TEXT };
          })
        : [{ type: 'text', text: OMITTED_TEXT }];
      return { ...value, content } as unknown as AgentMessage;
    }
    case 'compactionSummary':
      return { ...value, summary: String(value.summary ?? '').slice(0, 4_000) } as AgentMessage;
    default:
      return { ...value, content: OMITTED_TEXT, details: { compacted: true } } as AgentMessage;
  }
}

function emergencyCompact(
  messages: AgentMessage[],
  targetTokens: number,
  firstKeptEntryId: string,
  estimate: (messages: AgentMessage[]) => number,
  summary = LOSSY_SUMMARY,
): AgentMessage[] {
  const marker = {
    ...createCompactionSummaryMessage(summary, estimate(messages), new Date().toISOString()),
    details: { firstKeptEntryId, lossy: true },
  } as unknown as AgentMessage;
  const reduced = messages[0]?.role === 'compactionSummary' ? [...messages] : [marker, ...messages];

  // Preserve the user request and assistant tool-call envelope where possible:
  // large historical tool results are the most common cause of an oversized
  // context, so they are scrubbed before any other message.
  const candidates = [
    ...reduced.flatMap((message, index) =>
      index > 0 && message.role === 'toolResult' ? [index] : [],
    ),
    ...reduced.flatMap((message, index) =>
      index > 0 && message.role !== 'toolResult' ? [index] : [],
    ),
  ];
  for (const index of candidates) {
    if (estimate(reduced) < targetTokens) break;
    reduced[index] = scrubMessage(reduced[index]);
  }
  if (estimate(reduced) < targetTokens) return reduced;

  // Last-resort legal continuation. Static system/tool overhead can itself be
  // too large; report that loudly, but never return the original transcript.
  const minimal = [
    marker,
    {
      role: 'user',
      content: 'Continue from the compacted checkpoint above.',
      timestamp: Date.now(),
    },
  ] as AgentMessage[];
  if (estimate(minimal) >= targetTokens) {
    throw new Error(
      `static system/tool context exceeds compaction safety target ${targetTokens} even with a minimal transcript`,
    );
  }
  return minimal;
}

export function createCompactionRuntime(opts: CreateCompactionRuntimeOptions): CompactionRuntime {
  const contextWindow =
    opts.contextWindow != null && Number.isFinite(opts.contextWindow) && opts.contextWindow > 0
      ? Math.floor(opts.contextWindow)
      : 128_000;
  const windowSettings = resolveSettings(contextWindow, opts.settings);
  const sourceId = `maic-${opts.label}-compaction:${nanoid()}`;
  const api = sourceId as Api;
  const requestedOutputTokens =
    opts.maxOutputTokens != null &&
    Number.isFinite(opts.maxOutputTokens) &&
    opts.maxOutputTokens > 0
      ? Math.floor(opts.maxOutputTokens)
      : 0;
  const effectiveOutputTokens = requestedOutputTokens;
  const targetTokens = resolveCompactionTargetTokens(
    contextWindow,
    windowSettings.reserveTokens,
    effectiveOutputTokens,
  );
  const staticContextTokens = estimateFullContextTokens({
    messages: [],
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
  });
  const keepRecentTokens = resolveCompactionKeepRecentTokens(
    windowSettings.keepRecentTokens,
    targetTokens,
    staticContextTokens,
  );
  const settings = { ...windowSettings, keepRecentTokens };
  if (keepRecentTokens !== windowSettings.keepRecentTokens) {
    const message =
      `[compaction] keepRecentTokens=${windowSettings.keepRecentTokens} exceeds the safe tail ` +
      `budget for target ${targetTokens}; clamping to ${keepRecentTokens} after reserving ` +
      `${staticContextTokens} static tokens and 25% of the remaining dynamic budget for the summary`;
    if (!reportedKeepClamps.has(message)) {
      if (reportedKeepClamps.size >= 256) reportedKeepClamps.clear();
      reportedKeepClamps.add(message);
      console.warn(message);
    }
  }
  if (effectiveOutputTokens >= contextWindow) {
    console.warn(
      `[compaction] operator action required: ${opts.modelRouteLabel ?? opts.label} has ` +
        `output reservation ${effectiveOutputTokens} >= context window ${contextWindow}; ` +
        'the provider will reject requests. Compaction cannot fix this without reducing the ' +
        `output budget; fix the route or catalog configuration. Using safety target ${targetTokens}.`,
    );
  }
  const model = createConnectorModel(
    opts.label,
    api,
    contextWindow,
    effectiveOutputTokens || Math.min(8_192, contextWindow),
  );
  // Pi 0.80 takes the summarizer as a Models value instead of a global api
  // registry: pi's compaction runs through the connector's streamFn either way.
  const bridge = (
    bridgeModel: Model<Api>,
    context: Context,
    streamOptions?: StreamOptions | SimpleStreamOptions,
  ) => opts.streamFn(bridgeModel, context, streamOptions as never) as AssistantMessageEventStream;
  const summarizer = {
    completeSimple: async (
      bridgeModel: Model<Api>,
      context: Context,
      streamOptions?: SimpleStreamOptions,
    ) => (await bridge(bridgeModel, context, streamOptions)).result(),
  } as unknown as Models;

  let disposed = false;
  const trace: CompactionTrace = {
    enabled: true,
    contextWindow,
    reserveTokens: settings.reserveTokens,
    keepRecentTokens: settings.keepRecentTokens,
    effectiveOutputTokens,
    targetTokens,
    checkCount: 0,
    triggerCount: 0,
    summaryCalls: 0,
    failures: [],
    events: [],
  };

  const estimateView = (messages: AgentMessage[]) =>
    estimateFullContextTokens({
      messages,
      systemPrompt: opts.systemPrompt,
      tools: opts.tools,
    });
  const estimate = (messages: AgentMessage[]) =>
    Math.max(
      estimateView(messages),
      opts.budgetMessages ? estimateView(opts.budgetMessages(messages)) : 0,
    );
  const thresholdSettings = {
    ...settings,
    reserveTokens: contextWindow - targetTokens,
  };
  const assertFits = (messages: AgentMessage[]) => {
    if (estimate(messages) >= targetTokens) throw new ContextBudgetError('still_oversized');
    return messages;
  };
  const summaryAllowance = Math.floor(
    Math.max(0, targetTokens - staticContextTokens) * SUMMARY_BUDGET_SHARE,
  );
  /**
   * Choose the cut before paying for a summary. pi's findCutPoint sizes the
   * kept tail with its own chars/4 estimate, which undercounts CJK text and
   * ignores static context, so its cut can keep everything or leave a large
   * recent message that still cannot fit. Here keepRecentTokens is applied in
   * this runtime's units, then the cut moves to later boundaries until the
   * kept tail plus the summary allowance fits the target. pi still decides
   * which boundaries are legal: each candidate is expressed as the pi-unit
   * keep that selects it and passed through prepareCompaction.
   */
  const selectCompaction = (
    branch: SessionTreeEntry[],
    tokensBefore: number,
  ):
    | { kind: 'fit'; preparation: CompactionPreparation }
    | { kind: 'no_boundary' | 'oversized' } => {
    let boundaryStart = 0;
    const previous = branch.findLastIndex((entry) => entry.type === 'compaction');
    if (previous >= 0) {
      const compaction = branch[previous] as Extract<SessionTreeEntry, { type: 'compaction' }>;
      const kept = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
      boundaryStart = kept >= 0 ? kept : previous + 1;
    }
    const candidates = branch.flatMap((entry, index) =>
      index > boundaryStart && entry.type === 'message' ? [index] : [],
    );
    const messageAt = (index: number) =>
      (branch[index] as Extract<SessionTreeEntry, { type: 'message' }>).message;
    let start = 0;
    for (let i = candidates.length - 1, kept = 0; i >= 0; i -= 1) {
      kept += estimateFullContextTokens({ messages: [messageAt(candidates[i]!)] });
      if (kept >= settings.keepRecentTokens) {
        start = i;
        break;
      }
    }
    const piTail = (from: number) =>
      branch
        .slice(from)
        .reduce(
          (sum, entry) => sum + (entry.type === 'message' ? estimateTokens(entry.message) : 0),
          0,
        );
    const tried = new Set<string>();
    let sawCut = false;
    let splitFallback: { kind: 'fit'; preparation: CompactionPreparation } | undefined;
    for (const index of candidates.slice(start)) {
      const result = prepareCompaction(branch, { ...settings, keepRecentTokens: piTail(index) });
      if (!result.ok) throw result.error;
      const preparation = result.value;
      if (!preparation || tried.has(preparation.firstKeptEntryId)) continue;
      tried.add(preparation.firstKeptEntryId);
      const noOp =
        (preparation.messagesToSummarize.length === 0 &&
          preparation.turnPrefixMessages.length === 0) ||
        preparation.firstKeptEntryId === branch[0]?.id;
      if (noOp) continue;
      sawCut = true;
      const view = buildCompactedView(branch, {
        summary: '',
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore,
      });
      if (estimate(view) + summaryAllowance >= targetTokens) continue;
      // Bound pi's summary output (0.8 × reserve, plus 0.5 × reserve for a
      // split turn's prefix) to 80% of the allowance the cut was sized for.
      const summaryReserve = Math.max(
        64,
        Math.min(
          settings.reserveTokens,
          Math.floor((summaryAllowance * 0.8) / (preparation.isSplitTurn ? 1.3 : 0.8)),
        ),
      );
      const fit = {
        kind: 'fit' as const,
        preparation: {
          ...preparation,
          settings: { ...preparation.settings, reserveTokens: summaryReserve },
        },
      };
      // A split turn costs pi two summary calls (history + turn prefix). A
      // later cut at a user message keeps less but needs one, so prefer it
      // when it also fits; keep the split cut only as the fallback.
      if (!preparation.isSplitTurn) return fit;
      splitFallback ??= fit;
    }
    if (splitFallback) return splitFallback;
    return { kind: sawCut ? 'oversized' : 'no_boundary' };
  };
  const estimateText = (text: string) =>
    text ? estimateFullContextTokens({ messages: [], systemPrompt: text }) : 0;
  /**
   * Keep every summary request inside the summary model's window. Selecting
   * the cut only bounds what is kept; the history being summarized can itself
   * be larger than the window (after a switch to a smaller-window model, or
   * with large tool output). Such history is summarized oldest first in
   * bounded chunks through pi's own update path (previousSummary), so each
   * request carries one chunk plus the rolling summary. A split turn whose
   * prefix alone cannot fit is summarized as ordinary history instead.
   */
  const boundSummaryRequests = async (
    initial: CompactionPreparation,
    signal?: AbortSignal,
  ): Promise<{ preparation: CompactionPreparation; chunkCalls: number }> => {
    const reserve = initial.settings.reserveTokens;
    const fixed = SUMMARY_PROMPT_OVERHEAD_TOKENS + estimateText(opts.focusInstructions ?? '');
    const output = (share: number) => Math.min(Math.floor(share * reserve), model.maxTokens);
    const messageTokens = (message: AgentMessage) =>
      estimateText(serializeConversation(convertToLlm([message]))) + 1;
    const requestTokens = (messages: AgentMessage[], previousSummary?: string) =>
      fixed +
      estimateText(previousSummary ?? '') +
      messages.reduce((sum, message) => sum + messageTokens(message), 0) +
      output(0.8);
    let preparation = initial;
    // A window too small for even the prompt and output allowance cannot be
    // helped by chunking; leave the request to the provider as before.
    if (contextWindow - fixed - output(0.8) <= 0) return { preparation, chunkCalls: 0 };
    if (
      preparation.isSplitTurn &&
      fixed +
        preparation.turnPrefixMessages.reduce((sum, message) => sum + messageTokens(message), 0) +
        output(0.5) >
        contextWindow
    ) {
      preparation = {
        ...preparation,
        messagesToSummarize: [
          ...preparation.messagesToSummarize,
          ...preparation.turnPrefixMessages,
        ],
        turnPrefixMessages: [],
        isSplitTurn: false,
      };
    }
    // Plan every chunk before paying for any: a rolling summary is bounded by
    // the summary output allowance, so the plan assumes that worst case.
    const pending = preparation.messagesToSummarize;
    const tokens = pending.map(messageTokens);
    const tailTokens = (from: number) => tokens.slice(from).reduce((sum, value) => sum + value, 0);
    const requestBefore = requestTokens(pending, preparation.previousSummary);
    const chunkEnds: number[] = [];
    let from = 0;
    let rolling = estimateText(preparation.previousSummary ?? '');
    while (fixed + rolling + tailTokens(from) + output(0.8) > contextWindow) {
      let budget = contextWindow - fixed - rolling - output(0.8);
      let to = from;
      while (to < pending.length && tokens[to]! <= budget) {
        budget -= tokens[to]!;
        to += 1;
      }
      if (to === from) {
        throw new SummaryInputTooLargeError(
          'message_too_large',
          `a summary request needs about ${fixed + rolling + (tokens[from] ?? 0) + output(0.8)} ` +
            `tokens, more than the summary model window ${contextWindow}`,
        );
      }
      chunkEnds.push(to);
      if (chunkEnds.length > MAX_SUMMARY_CHUNK_CALLS) {
        throw new SummaryInputTooLargeError(
          'chunk_limit',
          `history to summarize needs more than ${MAX_SUMMARY_CHUNK_CALLS} chunk calls ` +
            `(about ${requestBefore} tokens for a ${contextWindow}-token window)`,
        );
      }
      from = to;
      rolling = output(0.8);
    }
    let chunkCalls = 0;
    let chunkStart = 0;
    for (const chunkEnd of chunkEnds) {
      const chunk = await generateSummary(
        pending.slice(chunkStart, chunkEnd),
        summarizer,
        model,
        reserve,
        signal,
        opts.focusInstructions,
        preparation.previousSummary,
        'off',
      );
      chunkCalls += 1;
      trace.summaryCalls += 1;
      if (!chunk.ok) throw chunk.error;
      preparation = { ...preparation, previousSummary: chunk.value };
      chunkStart = chunkEnd;
    }
    preparation = { ...preparation, messagesToSummarize: pending.slice(chunkStart) };
    if (chunkCalls > 0) {
      // Cost is visible: these are extra paid calls before the final summary.
      console.warn('[compaction] summarized oversized history in chunks', {
        chunkCalls,
        requestTokens: requestBefore,
        contextWindow,
        modelRoute: opts.modelRouteLabel ?? opts.label,
      });
    }
    return { preparation, chunkCalls };
  };
  const recordSummaryFailure = (error: unknown, messages: AgentMessage[], signal?: AbortSignal) => {
    const failure = describeSummaryFailure(error, {
      modelRoute: opts.modelRouteLabel ?? opts.label,
      aborted: signal?.aborted,
    });
    trace.failures.push(`summary failed: ${failure.errorName}`);
    trace.lastSummaryFailure = failure;
    // Metadata only: never the summarized history, the prompt, or a summary.
    console.warn('[compaction] summary failed; checking context budget', failure);
    return recoverSummaryFailure(messages, signal);
  };
  const recoverSummaryFailure = (messages: AgentMessage[], signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason ?? new Error('Compaction aborted');
    // Never pass an oversized transcript through merely because summarization failed.
    if (estimate(messages) >= targetTokens) throw new ContextBudgetError('summary_failed');
    return messages;
  };
  return {
    transformContext: async (messages, signal) => {
      if (disposed) throw new Error('Compaction runtime is disposed');
      if (effectiveOutputTokens >= contextWindow)
        throw new ContextBudgetError('invalid_output_budget');
      if (!settings.enabled) return assertFits(messages);
      const durable = opts.compactionSession?.required === true;
      try {
        let session: Session;
        if (opts.compactionSession) {
          session = await opts.compactionSession.acquire(messages, signal);
        } else {
          session = await new InMemorySessionRepo().create();
          for (const message of messages) await session.appendMessage(message);
        }
        const beforeContext = await session.buildContext();
        const tokensBefore = estimate(beforeContext.messages);
        trace.checkCount += 1;
        if (!shouldCompact(tokensBefore, contextWindow, thresholdSettings)) {
          return assertFits(beforeContext.messages);
        }

        const branch = await session.getBranch();
        const selection = selectCompaction(branch, tokensBefore);
        if (selection.kind !== 'fit') {
          // Even the latest legal cut cannot fit: block a durable session
          // without paying for a summary; stateless callers degrade lossily.
          if (durable) {
            throw new ContextBudgetError(
              selection.kind === 'no_boundary' ? 'no_compaction_boundary' : 'still_oversized',
            );
          }
          const firstKeptEntryId = branch[0]?.id ?? 'unknown';
          const degraded = emergencyCompact(
            beforeContext.messages,
            targetTokens,
            firstKeptEntryId,
            estimate,
          );
          const tokensAfter = estimate(degraded);
          trace.triggerCount += 1;
          const event: CompactionEvent = {
            tokensBefore,
            tokensAfter,
            messagesBefore: beforeContext.messages.length,
            messagesAfter: degraded.length,
            firstKeptEntryId,
            summary: LOSSY_SUMMARY,
            summaryCalls: 0,
          };
          trace.events.push(event);
          console.warn('[compaction] no compaction cut fits; applied lossy fallback');
          opts.onCompaction?.(event);
          return assertFits(degraded);
        }

        let preparation: CompactionPreparation;
        let chunkCalls: number;
        try {
          ({ preparation, chunkCalls } = await boundSummaryRequests(selection.preparation, signal));
        } catch (error) {
          if (signal?.aborted) throw error;
          return recordSummaryFailure(error, beforeContext.messages, signal);
        }
        const finalCalls = preparation.isSplitTurn ? 2 : 1;
        const summaryCalls = chunkCalls + finalCalls;
        trace.summaryCalls += finalCalls;
        let compactResult: Awaited<ReturnType<typeof compact>>;
        try {
          compactResult = await compact(
            preparation,
            summarizer,
            model,
            opts.focusInstructions,
            signal,
            'off',
          );
        } catch (error) {
          return recordSummaryFailure(error, beforeContext.messages, signal);
        }
        if (!compactResult.ok) {
          // Failure is not permission to bypass context admission.
          return recordSummaryFailure(compactResult.error, beforeContext.messages, signal);
        }

        const result = compactResult.value;
        let transformed = buildCompactedView(branch, {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore,
        });
        if (estimate(transformed) >= targetTokens) {
          // Do not persist an unsafe durable cut. The original tree remains retryable.
          if (durable) throw new ContextBudgetError('still_oversized');
          transformed = emergencyCompact(
            transformed,
            targetTokens,
            result.firstKeptEntryId,
            estimate,
            result.summary,
          );
        }
        assertFits(transformed);
        if (signal?.aborted) throw signal.reason ?? new Error('Compaction aborted');
        const tokensAfter = estimate(transformed);
        const event: CompactionEvent = {
          tokensBefore,
          tokensAfter,
          messagesBefore: beforeContext.messages.length,
          messagesAfter: transformed.length,
          firstKeptEntryId: result.firstKeptEntryId,
          summary: result.summary,
          summaryCalls,
        };
        await session.appendCompaction(result.summary, result.firstKeptEntryId, tokensBefore, {
          ...(result.details && typeof result.details === 'object' ? result.details : {}),
          tokensAfter,
          messagesBefore: event.messagesBefore,
          messagesAfter: event.messagesAfter,
        });
        if (durable) transformed = (await session.buildContext()).messages;
        trace.triggerCount += 1;
        trace.events.push(event);
        opts.onCompaction?.(event);
        return assertFits(transformed);
      } catch (error) {
        trace.failures.push(error instanceof Error ? error.message : String(error));
        if (durable || error instanceof ContextBudgetError || signal?.aborted) throw error;
        console.error('[compaction] failed; applying lossy fallback', error);
        return assertFits(emergencyCompact(messages, targetTokens, 'unknown', estimate));
      }
    },
    getTrace: () => ({
      ...trace,
      ...(trace.lastSummaryFailure ? { lastSummaryFailure: { ...trace.lastSummaryFailure } } : {}),
      failures: [...trace.failures],
      events: trace.events.map((event) => ({ ...event })),
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
    },
  };
}
