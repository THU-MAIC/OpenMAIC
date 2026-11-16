import { createHash, randomBytes } from 'node:crypto';
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import { requestSystemTail, withRequestSystemTail } from '@/lib/agent/runtime/request-system-tail';

export const PLAN_TOOL_REFERENCE =
  'The exact initial PLAN.md file text is retained in the successful file tool record identified by initialPlanSource in current host state.';

export interface InitialPlanContext {
  text: string;
  literalPrompt: string;
  referencePrompt: string;
}

const PROJECTION = Symbol('openmaic.initial-plan-projection');
type PlanContext = Context & {
  [PROJECTION]?: InitialPlanContext & { suffix: string };
};

function result(message: Message): Record<string, unknown> | null {
  if (message.role !== 'toolResult' || message.isError) return null;
  try {
    const value = JSON.parse(
      message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    );
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function planReceipt(messages: Message[], text: string): Message | undefined {
  const hash = createHash('sha256').update(text).digest('hex');
  return messages.findLast((message, index) => {
    const value = result(message);
    if (!value || value.hash !== hash || message.role !== 'toolResult') return false;
    if (message.toolName === 'read_file')
      return (
        value.path === 'PLAN.md' &&
        value.text === text &&
        (value.offset === undefined || value.offset === 0) &&
        value.nextOffset == null
      );
    if (message.toolName !== 'write_file' || value.written !== true) return false;
    return messages
      .slice(0, index)
      .some(
        (call) =>
          call.role === 'assistant' &&
          call.content.some(
            (part) =>
              part.type === 'toolCall' &&
              part.id === message.toolCallId &&
              part.name === 'write_file' &&
              part.arguments.path === 'PLAN.md' &&
              part.arguments.text === text,
          ),
      );
  });
}

/** Serialize the real run-start file read once if its complete version is absent.
 * The runner delivers this pair through the same fenced message chain as skill
 * preloads. It adds no learner frame, executes no tool and changes no approval.
 */
export function preloadInitialPlan(
  context: Context,
  plan: InitialPlanContext | undefined,
  model: { api: AssistantMessage['api']; provider: string; id: string },
): Message[] {
  if (!plan || planReceipt(context.messages, plan.text)) return [];
  const toolCallId = `call_plnpre_${randomBytes(12).toString('hex')}`;
  const timestamp = Date.now();
  return [
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', name: 'read_file', id: toolCallId, arguments: { path: 'PLAN.md' } },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp,
    },
    {
      role: 'toolResult',
      toolName: 'read_file',
      toolCallId,
      isError: false,
      timestamp,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            path: 'PLAN.md',
            text: plan.text,
            hash: createHash('sha256').update(plan.text).digest('hex'),
            reviewLink: '#pbl-file=PLAN.md',
            lineCount: plan.text.split('\n').length,
          }),
        },
      ],
    },
  ];
}

/** Reuse only byte-identical full file data retained in this request's host tool history.
 * Section instructions and current feedback/approval state are never replaced.
 * Missing/compacted receipts fall back to the original complete file snapshot.
 */
export function withPlanToolContext(context: Context, plan?: InitialPlanContext): Context {
  const prior = (context as PlanContext)[PROJECTION];
  let systemPrompt = context.systemPrompt ?? '';
  let tail = requestSystemTail(context);
  if (prior) {
    systemPrompt = systemPrompt.replace(prior.referencePrompt, prior.literalPrompt);
    tail = tail.replace(prior.suffix, '');
  }
  const receipt =
    plan && systemPrompt.includes(plan.literalPrompt)
      ? planReceipt(context.messages, plan.text)
      : undefined;
  const hash = plan ? createHash('sha256').update(plan.text).digest('hex') : '';
  const { [PROJECTION]: _prior, ...base } = context as PlanContext;
  if (!plan || !receipt || receipt.role !== 'toolResult')
    return !prior ? context : withRequestSystemTail({ ...base, systemPrompt }, tail);
  const suffix =
    '\nInitial PLAN.md file source: ' +
    JSON.stringify({
      initialPlanSource: {
        path: 'PLAN.md',
        toolCallId: receipt.toolCallId,
        hash,
      },
    });
  return {
    ...withRequestSystemTail(
      {
        ...base,
        systemPrompt: systemPrompt.replace(plan.literalPrompt, plan.referencePrompt),
      },
      tail + suffix,
    ),
    [PROJECTION]: { ...plan, suffix },
  } as PlanContext;
}
