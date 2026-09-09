import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from '@ai-sdk/provider';
import type { ThinkingConfig } from '@/lib/types/provider';
import { requireCodexChatgptAccount } from './account';
import { getCodexAppServer, type CodexAppServer } from './app-server-client';

interface ThreadStartResponse {
  thread: { id: string };
}

interface TurnStartResponse {
  turn: { id: string };
}

interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface CodexTurnResult {
  text: string;
  usage: LanguageModelV3Usage;
  warnings: SharedV3Warning[];
  status: string;
}

interface CodexUserInput {
  type: 'text' | 'image';
  text?: string;
  text_elements?: never[];
  url?: string;
}

const PROVIDER_INSTRUCTIONS =
  'Act only as a language-model backend for OpenMAIC. Follow the conversation and instructions in the user input. Return the requested final content without commentary. Do not inspect files, run commands, call tools, browse the web, or modify the environment.';
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const BACKEND_CONFIG = {
  web_search: 'disabled',
  include_apps_instructions: false,
  include_environment_context: false,
  include_permissions_instructions: false,
  project_doc_max_bytes: 0,
  features: {
    apps: false,
    auth_elicitation: false,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    computer_use: false,
    goals: false,
    hooks: false,
    image_generation: false,
    in_app_browser: false,
    multi_agent: false,
    multi_agent_v2: false,
    plugin_sharing: false,
    plugins: false,
    remote_plugin: false,
    request_permissions_tool: false,
    shell_snapshot: false,
    shell_tool: false,
    skill_mcp_dependency_install: false,
    skill_search: false,
    sleep_tool: false,
    standalone_web_search: false,
    tool_call_mcp_elicitation: false,
    tool_suggest: false,
    unified_exec: false,
    view_image: false,
    workspace_dependencies: false,
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

function mapUsage(value: unknown): LanguageModelV3Usage {
  const tokenUsage = asRecord(value);
  const last = asRecord(tokenUsage?.last);
  if (!last) return emptyUsage();

  const usage = last as unknown as Partial<TokenUsageBreakdown>;
  const input = usage.inputTokens;
  const cached = usage.cachedInputTokens;
  const cacheWrite = usage.cacheWriteInputTokens;
  const output = usage.outputTokens;
  const reasoning = usage.reasoningOutputTokens;

  return {
    inputTokens: {
      total: input,
      noCache:
        input === undefined ? undefined : Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)),
      cacheRead: cached,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)),
      reasoning,
    },
    raw: {
      inputTokens: input ?? null,
      cachedInputTokens: cached ?? null,
      cacheWriteInputTokens: cacheWrite ?? null,
      outputTokens: output ?? null,
      reasoningOutputTokens: reasoning ?? null,
    },
  };
}

function unsupportedWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  const unsupported: Array<[string, unknown]> = [
    ['maxOutputTokens', options.maxOutputTokens],
    ['temperature', options.temperature],
    ['stopSequences', options.stopSequences],
    ['topP', options.topP],
    ['topK', options.topK],
    ['presencePenalty', options.presencePenalty],
    ['frequencyPenalty', options.frequencyPenalty],
    ['seed', options.seed],
  ];
  for (const [feature, value] of unsupported) {
    if (value !== undefined) {
      warnings.push({
        type: 'unsupported',
        feature,
        details: 'Codex App Server does not expose this sampling control.',
      });
    }
  }
  return warnings;
}

function formatToolOutput(output: unknown): string {
  const record = asRecord(output);
  if (!record) return String(output);
  if (typeof record.value === 'string') return record.value;
  if ('value' in record) return JSON.stringify(record.value);
  if (typeof record.reason === 'string') return record.reason;
  return JSON.stringify(record);
}

function fileUrl(data: Uint8Array | string | URL, mediaType: string): string {
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) {
    return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
  }
  if (/^(?:https?:|data:)/iu.test(data)) return data;
  return `data:${mediaType};base64,${data}`;
}

export function promptToCodexInput(prompt: LanguageModelV3Prompt): {
  input: CodexUserInput[];
  warnings: SharedV3Warning[];
} {
  const transcript: string[] = [];
  const images: CodexUserInput[] = [];
  const warnings: SharedV3Warning[] = [];

  for (const message of prompt) {
    if (message.role === 'system') {
      transcript.push(`SYSTEM:\n${message.content}`);
      continue;
    }

    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'reasoning') {
        parts.push(`[reasoning]\n${part.text}`);
      } else if (part.type === 'tool-call') {
        parts.push(`[tool call: ${part.toolName}]\n${JSON.stringify(part.input)}`);
      } else if (part.type === 'tool-result') {
        parts.push(`[tool result: ${part.toolName}]\n${formatToolOutput(part.output)}`);
      } else if (part.type === 'tool-approval-response') {
        parts.push(`[tool approval: ${part.approved ? 'approved' : 'denied'}]`);
      } else if (part.type === 'file') {
        if (part.mediaType.startsWith('image/')) {
          images.push({ type: 'image', url: fileUrl(part.data, part.mediaType) });
          parts.push(`[attached image${part.filename ? `: ${part.filename}` : ''}]`);
        } else {
          parts.push(`[unsupported attachment${part.filename ? `: ${part.filename}` : ''}]`);
          warnings.push({
            type: 'unsupported',
            feature: `file input (${part.mediaType})`,
            details: 'The Codex provider currently forwards image attachments only.',
          });
        }
      }
    }
    transcript.push(`${message.role.toUpperCase()}:\n${parts.join('\n')}`);
  }

  const text =
    transcript.length > 0
      ? `${transcript.join('\n\n')}\n\nRespond with the next ASSISTANT message only.`
      : 'Respond to the attached image.';
  return {
    input: [{ type: 'text', text, text_elements: [] }, ...images],
    warnings,
  };
}

function currentReasoningEffort(): string | undefined {
  const context = (globalThis as Record<string, unknown>).__thinkingContext as
    | { getStore?: () => ThinkingConfig | undefined }
    | undefined;
  const thinking = context?.getStore?.();
  if (!thinking) return undefined;
  if (thinking.mode === 'disabled' || thinking.enabled === false || thinking.effort === 'none') {
    return undefined;
  }
  return thinking.effort;
}

function finalTextFromTurn(turnValue: unknown): string | undefined {
  const turn = asRecord(turnValue);
  if (!Array.isArray(turn?.items)) return undefined;
  let text: string | undefined;
  for (const value of turn.items) {
    const item = asRecord(value);
    if (
      item?.type === 'agentMessage' &&
      item.phase !== 'commentary' &&
      typeof item.text === 'string'
    ) {
      text = item.text;
    }
  }
  return text;
}

async function runCodexTurn(
  modelId: string,
  options: LanguageModelV3CallOptions,
  client: CodexAppServer,
  onDelta?: (delta: string) => void,
): Promise<CodexTurnResult> {
  if (options.tools && options.tools.length > 0) {
    throw new Error('The Codex subscription provider does not support OpenMAIC tool calls yet.');
  }
  if (options.abortSignal?.aborted) throw abortError();

  await requireCodexChatgptAccount(client);
  const workingDirectory = await mkdtemp(path.join(tmpdir(), 'openmaic-codex-'));
  const converted = promptToCodexInput(options.prompt);
  const warnings = [...unsupportedWarnings(options), ...converted.warnings];

  try {
    const thread = await client.request<ThreadStartResponse>('thread/start', {
      model: modelId,
      cwd: workingDirectory,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: BACKEND_CONFIG,
      baseInstructions: PROVIDER_INSTRUCTIONS,
      developerInstructions: PROVIDER_INSTRUCTIONS,
      ephemeral: true,
      environments: [],
      dynamicTools: [],
    });
    const threadId = thread.thread.id;
    let turnId: string | null = null;
    let finalText = '';
    let usage = emptyUsage();
    let status = 'completed';
    const itemPhases = new Map<string, unknown>();
    const streamedByItem = new Map<string, string>();

    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const timeout = setTimeout(() => {
      if (turnId) {
        void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      }
      rejectDone(new Error('Codex generation timed out.'));
    }, TURN_TIMEOUT_MS);

    const unsubscribe = client.onNotification((method, rawParams) => {
      try {
        if (method === 'server/closed') {
          const params = asRecord(rawParams);
          rejectDone(new Error(String(params?.error || 'Codex App Server stopped.')));
          return;
        }

        const params = asRecord(rawParams);
        if (!params || params.threadId !== threadId) return;
        if (turnId && typeof params.turnId === 'string' && params.turnId !== turnId) return;

        if (method === 'item/started') {
          const item = asRecord(params.item);
          if (item?.type === 'agentMessage' && typeof item.id === 'string') {
            itemPhases.set(item.id, item.phase);
          }
          return;
        }

        if (method === 'item/agentMessage/delta') {
          const itemId = typeof params.itemId === 'string' ? params.itemId : '';
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (!itemId || !delta || itemPhases.get(itemId) === 'commentary') return;
          streamedByItem.set(itemId, `${streamedByItem.get(itemId) || ''}${delta}`);
          onDelta?.(delta);
          return;
        }

        if (method === 'item/completed') {
          const item = asRecord(params.item);
          if (
            item?.type === 'agentMessage' &&
            item.phase !== 'commentary' &&
            typeof item.text === 'string'
          ) {
            finalText = item.text;
            const itemId = typeof item.id === 'string' ? item.id : '';
            const streamed = streamedByItem.get(itemId) || '';
            if (!streamed) onDelta?.(item.text);
            else if (item.text.startsWith(streamed)) onDelta?.(item.text.slice(streamed.length));
          }
          return;
        }

        if (method === 'thread/tokenUsage/updated') {
          usage = mapUsage(params.tokenUsage);
          return;
        }

        if (method === 'error' && params.willRetry !== true) {
          const error = asRecord(params.error);
          rejectDone(new Error(String(error?.message || 'Codex generation failed.')));
          return;
        }

        if (method === 'turn/completed') {
          const turn = asRecord(params.turn);
          status = typeof turn?.status === 'string' ? turn.status : 'completed';
          finalText = finalTextFromTurn(turn) ?? finalText;
          if (status === 'failed') {
            const error = asRecord(turn?.error);
            rejectDone(new Error(String(error?.message || 'Codex generation failed.')));
          } else {
            resolveDone();
          }
        }
      } catch (error) {
        rejectDone(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const handleAbort = () => {
      if (turnId) {
        void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      }
      rejectDone(abortError());
    };
    options.abortSignal?.addEventListener('abort', handleAbort, { once: true });

    try {
      const turn = await client.request<TurnStartResponse>('turn/start', {
        threadId,
        input: converted.input,
        cwd: workingDirectory,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        environments: [],
        model: modelId,
        effort: currentReasoningEffort(),
        outputSchema:
          options.responseFormat?.type === 'json' ? options.responseFormat.schema : undefined,
      });
      turnId = turn.turn.id;
      if (options.abortSignal?.aborted) handleAbort();
      await done;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      options.abortSignal?.removeEventListener('abort', handleAbort);
    }

    return { text: finalText, usage, warnings, status };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createCodexLanguageModel(
  modelId: string,
  client: CodexAppServer = getCodexAppServer(),
): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'codex',
    modelId,
    supportedUrls: { 'image/*': [/^(?:https?:|data:)/iu] },

    async doGenerate(options) {
      const result = await runCodexTurn(modelId, options, client);
      return {
        content: [{ type: 'text', text: result.text }],
        finishReason: {
          unified: result.status === 'completed' ? 'stop' : 'other',
          raw: result.status,
        },
        usage: result.usage,
        warnings: result.warnings,
      };
    },

    async doStream(options) {
      const internalAbort = new AbortController();
      const externalAbort = () => internalAbort.abort();
      options.abortSignal?.addEventListener('abort', externalAbort, { once: true });
      let cancelled = false;

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          const textId = 'codex-text';
          const converted = promptToCodexInput(options.prompt);
          controller.enqueue({
            type: 'stream-start',
            warnings: [...unsupportedWarnings(options), ...converted.warnings],
          });
          controller.enqueue({ type: 'text-start', id: textId });

          void runCodexTurn(
            modelId,
            { ...options, abortSignal: internalAbort.signal },
            client,
            (delta) => {
              if (!cancelled && delta)
                controller.enqueue({ type: 'text-delta', id: textId, delta });
            },
          )
            .then((result) => {
              if (cancelled) return;
              controller.enqueue({ type: 'text-end', id: textId });
              controller.enqueue({
                type: 'finish',
                usage: result.usage,
                finishReason: {
                  unified: result.status === 'completed' ? 'stop' : 'other',
                  raw: result.status,
                },
              });
              controller.close();
            })
            .catch((error) => {
              if (!cancelled) controller.error(error);
            })
            .finally(() => {
              options.abortSignal?.removeEventListener('abort', externalAbort);
            });
        },
        cancel() {
          cancelled = true;
          internalAbort.abort();
          options.abortSignal?.removeEventListener('abort', externalAbort);
        },
      });

      return { stream };
    },
  };
}
