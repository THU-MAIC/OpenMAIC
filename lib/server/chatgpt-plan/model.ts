/**
 * ChatGPT plan models: the OpenAI Responses API on api.openai.com, sent with
 * the connected account's token, shaped to what plan usage accepts.
 */
import 'server-only';

import { createOpenAI } from '@ai-sdk/openai';
import {
  APICallError,
  type JSONValue,
  type LanguageModel,
  type LanguageModelMiddleware,
  UnsupportedFunctionalityError,
  wrapLanguageModel,
} from 'ai';

import { thinkingContext } from '@/lib/ai/thinking-context';
import { pickThinkingEffort } from '@/lib/ai/thinking-config';
import type { ThinkingCapability, ThinkingEffort } from '@/lib/types/provider';
import { generateViaStreamMiddleware } from '@/lib/ai/generate-via-stream';
import { CHATGPT_PLAN_PROVIDER_ID, type ChatGPTPlanModel } from '@/lib/chatgpt-plan/shared';
import { publicProviderFailure } from '@/lib/server/llm-error-response';
import { createLogger } from '@/lib/logger';

import {
  ChatGPTPlanError,
  connectionCallError,
  ENDED_EARLY,
  failureFrom,
  isPlanUsageFailure,
  planCallError,
  type UpstreamFailure,
} from './errors';
import { inferenceFetch } from './http';
import { CHATGPT_PLAN_API_BASE } from './oauth';
import { chatGPTPlanAccessToken } from './session';

const log = createLogger('ChatGPT Plan');

// ── Transport ────────────────────────────────────────────────────────────────

const ERROR_BODY_LIMIT = 64 * 1024;

async function readFailure(response: Response): Promise<UpstreamFailure> {
  const requestId = response.headers.get('x-request-id') ?? undefined;
  let body: unknown;
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        chunks.push(next.value);
        size += next.value.byteLength;
        if (size > ERROR_BODY_LIMIT) break;
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      // Without a readable body, the status alone classifies the failure.
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
  const failure = {
    status: response.status,
    ...failureFrom(body),
    ...(requestId ? { requestId } : {}),
  };
  // The code and request ID identify the failure; the server's message can echo the request.
  log.warn(
    `ChatGPT plan request answered HTTP ${failure.status}${failure.code ? ` (${failure.code})` : ''}${requestId ? `, request ID ${requestId}` : ''}`,
  );
  return failure;
}

async function accessToken(url: string, rejected?: string): Promise<string> {
  try {
    return await chatGPTPlanAccessToken(rejected);
  } catch (error) {
    throw error instanceof ChatGPTPlanError ? connectionCallError(error, url) : error;
  }
}

/**
 * `fetch` for the plan API: adds the account's access token (to plan API
 * URLs only), refreshes it once when the API refuses it, and reports an error
 * response as a {@link planCallError}.
 */
const planFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(`${CHATGPT_PLAN_API_BASE}/`)) {
    throw new Error(`ChatGPT plan requests go to ${CHATGPT_PLAN_API_BASE} only.`);
  }
  const send = (token: string) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return inferenceFetch(url, { ...init, headers });
  };
  let token = await accessToken(url);
  let response = await send(token);
  if (response.status === 401) {
    const failure = await readFailure(response);
    if (isPlanUsageFailure(failure)) throw planCallError(failure, { url });
    token = await accessToken(url, token);
    response = await send(token);
  }
  if (!response.ok) throw planCallError(await readFailure(response), { url });
  return response;
};

// ── Request and stream policy ────────────────────────────────────────────────

/** Function tools are sent in one namespace, as plan usage requires. */
const TOOL_NAMESPACE = { name: 'openmaic', description: 'Tools provided by OpenMAIC.' };

/** OpenAI options plan usage does not accept. */
const UNSUPPORTED_OPENAI_OPTIONS = [
  'conversation',
  'logprobs',
  'maxToolCalls',
  'metadata',
  'previousResponseId',
  'promptCacheOptions',
  'promptCacheRetention',
  'safetyIdentifier',
  'truncation',
  'user',
];

type CallOptions = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];
type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>;
type StreamPart =
  Awaited<ReturnType<Parameters<WrapStream>[0]['doStream']>>['stream'] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;
type Warning = Extract<StreamPart, { type: 'stream-start' }>['warnings'][number];

interface RequestNotes {
  warnings: Warning[];
  /** Whether the caller asked for raw chunks; the policy always reads them. */
  rawRequested: boolean;
}

// Keyed by the transformed call options, which reach `wrapStream` unchanged.
const notes = new WeakMap<CallOptions, RequestNotes>();

const unsupported = (feature: string): Warning => ({
  type: 'unsupported',
  feature,
  details: 'ChatGPT plan usage does not accept this setting; it was not sent.',
});

function shapeRequest(params: CallOptions, thinking?: ThinkingCapability): CallOptions {
  const { maxOutputTokens, temperature, topP, ...rest } = params;
  const warnings = Object.entries({ maxOutputTokens, temperature, topP })
    .filter(([, value]) => value !== undefined)
    .map(([feature]) => unsupported(feature));

  const openai: Record<string, JSONValue | undefined> = { ...rest.providerOptions?.openai };
  for (const key of UNSUPPORTED_OPENAI_OPTIONS) {
    if (openai[key] === undefined) continue;
    delete openai[key];
    warnings.push(unsupported(`providerOptions.openai.${key}`));
  }

  // Leading system messages become the request's instructions; plan usage
  // accepts no system items, so any later one is sent as a developer message.
  let lead = 0;
  while (rest.prompt[lead]?.role === 'system') lead += 1;
  const instructions = [
    typeof openai.instructions === 'string' ? openai.instructions : undefined,
    ...rest.prompt
      .slice(0, lead)
      .map((message) => (message.role === 'system' ? message.content : '')),
  ].filter(Boolean);

  const config = thinkingContext.getStore();
  const effort = thinking && config ? pickThinkingEffort(thinking, config) : openai.reasoningEffort;
  delete openai.reasoningEffort;
  if (thinking?.effortValues?.includes(effort as ThinkingEffort)) openai.reasoningEffort = effort;
  // The SDK's named tool_choice refers to a top-level function. Require the
  // selected namespace member by offering it as the sole available tool.
  const choice = rest.toolChoice;
  const allowedTools =
    choice?.type === 'tool'
      ? rest.tools?.filter((tool) => tool.name === choice.toolName)
      : rest.tools;
  const tools = allowedTools?.map((tool) => {
    if (tool.type !== 'function') {
      throw new UnsupportedFunctionalityError({
        functionality: `ChatGPT plan usage with provider tool ${tool.id}`,
      });
    }
    return {
      ...tool,
      // Responses can make optional arguments required when strict is omitted.
      strict: tool.strict ?? false,
      providerOptions: {
        ...tool.providerOptions,
        openai: { ...tool.providerOptions?.openai, namespace: TOOL_NAMESPACE },
      },
    };
  });
  // Tool calls from earlier turns (possibly another provider's) name the namespace too.
  const prompt = rest.prompt.slice(lead).map((message) =>
    message.role !== 'assistant'
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type !== 'tool-call' || part.providerOptions?.openai?.namespace
              ? part
              : {
                  ...part,
                  providerOptions: {
                    ...part.providerOptions,
                    openai: { ...part.providerOptions?.openai, namespace: TOOL_NAMESPACE.name },
                  },
                },
          ),
        },
  );

  const shaped: CallOptions = {
    ...rest,
    prompt,
    ...(choice?.type === 'tool' ? { toolChoice: { type: 'required' as const } } : {}),
    ...(tools ? { tools } : {}),
    // Raw chunks show `response.failed`, which the SDK reports without an error.
    includeRawChunks: true,
    providerOptions: {
      ...rest.providerOptions,
      openai: {
        ...openai,
        store: false,
        forceReasoning: true,
        systemMessageMode: 'developer',
        ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
      },
    },
  };
  notes.set(shaped, { warnings, rawRequested: params.includeRawChunks === true });
  return shaped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** An error the stream reported, as a {@link planCallError}. */
function streamError(error: unknown, url: string, requestId: string | undefined): unknown {
  if (publicProviderFailure(error)) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  const frame = APICallError.isInstance(error) ? error.data : error;
  if (!isRecord(frame)) log.warn('ChatGPT plan stream failed:', error);
  return planCallError({ ...failureFrom(frame), ...(requestId ? { requestId } : {}) }, { url });
}

/**
 * Shapes each request to what plan usage accepts (warning about each setting
 * it leaves out) and checks each response stream: only `response.completed`
 * ends one successfully.
 */
function chatGPTPlanPolicy(url: string, thinking?: ThinkingCapability): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => shapeRequest(params, thinking),
    wrapStream: async ({ doStream, params }) => {
      const { warnings, rawRequested } = notes.get(params) ?? { warnings: [], rawRequested: false };
      let result;
      try {
        result = await doStream();
      } catch (error) {
        throw APICallError.isInstance(error) &&
          !publicProviderFailure(error) &&
          error.data !== undefined
          ? streamError(error, url, undefined)
          : error;
      }
      const requestId = result.response?.headers?.['x-request-id'];
      let ended = false;
      let failed = false;
      const fail = (error: unknown): StreamPart => {
        failed = true;
        return { type: 'error', error: streamError(error, url, requestId) };
      };
      const endedEarly = () => fail({ code: ENDED_EARLY });
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            const enqueue = (value: StreamPart) => controller.enqueue(value);
            switch (part.type) {
              case 'stream-start':
                enqueue({ ...part, warnings: [...part.warnings, ...warnings] });
                return;
              case 'raw': {
                const event = isRecord(part.rawValue) ? part.rawValue.type : undefined;
                if (event === 'response.completed') ended = true;
                if (event === 'response.incomplete' && !failed)
                  enqueue(fail({ code: 'response_incomplete' }));
                if (event === 'response.failed' && !failed) enqueue(fail(part.rawValue));
                if (rawRequested) enqueue(part);
                return;
              }
              case 'error':
                if (!failed) enqueue(fail(part.error));
                return;
              case 'finish':
                if (!ended && !failed) enqueue(endedEarly());
                enqueue(part);
                return;
              default:
                enqueue(part);
            }
          },
          flush(controller) {
            if (!ended && !failed) controller.enqueue(endedEarly());
          },
        }),
      );
      return { ...result, stream };
    },
  };
}

// ── Models ───────────────────────────────────────────────────────────────────

/** A ChatGPT plan model, by the slug `/v1/models` lists. */
export function chatGPTPlanLanguageModel(
  modelId: string,
  thinking?: ThinkingCapability,
): LanguageModel {
  const provider = createOpenAI({
    baseURL: CHATGPT_PLAN_API_BASE,
    // Replaced by the account's token in `planFetch`.
    apiKey: CHATGPT_PLAN_PROVIDER_ID,
    name: CHATGPT_PLAN_PROVIDER_ID,
    fetch: planFetch,
  });
  return wrapLanguageModel({
    model: provider.responses(modelId),
    // Generate calls go through the stream, so the policy checks them too.
    middleware: [
      generateViaStreamMiddleware(),
      chatGPTPlanPolicy(`${CHATGPT_PLAN_API_BASE}/responses`, thinking),
    ],
    providerId: CHATGPT_PLAN_PROVIDER_ID,
  });
}

/** The models the connected account offers, in the order the server lists them. */
export async function listChatGPTPlanModels(): Promise<ChatGPTPlanModel[]> {
  const response = await planFetch(`${CHATGPT_PLAN_API_BASE}/models`, {
    headers: { accept: 'application/json' },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (
    !isRecord(body) ||
    !Array.isArray(body.models) ||
    body.models.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.slug !== 'string' ||
        !entry.slug ||
        typeof entry.visibility !== 'string',
    )
  ) {
    throw planCallError(
      { code: 'openmaic_invalid_model_list' },
      { url: `${CHATGPT_PLAN_API_BASE}/models` },
    );
  }
  const listed = body.models;
  return listed.flatMap((model): ChatGPTPlanModel[] => {
    if (!isRecord(model) || typeof model.slug !== 'string' || model.visibility !== 'list') {
      return [];
    }
    if (model.supported_in_api === false) return [];
    const effortValues: ThinkingEffort[] = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.flatMap((entry) => {
          const effort = isRecord(entry) ? entry.effort : entry;
          return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
            ? [effort]
            : [];
        })
      : [];
    return [
      {
        id: model.slug,
        ...(effortValues.length
          ? {
              thinking: {
                control: 'effort' as const,
                requestAdapter: 'openai' as const,
                effortValues,
                ...(effortValues.includes(model.default_reasoning_level as ThinkingEffort)
                  ? { defaultEffort: model.default_reasoning_level as ThinkingEffort }
                  : {}),
              },
            }
          : {}),
        name: typeof model.display_name === 'string' ? model.display_name : model.slug,
        ...(typeof model.context_window === 'number'
          ? { contextWindow: model.context_window }
          : {}),
        ...(Array.isArray(model.input_modalities)
          ? { vision: model.input_modalities.includes('image') }
          : {}),
      },
    ];
  });
}
