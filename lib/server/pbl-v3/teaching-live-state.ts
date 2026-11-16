import type { Context, Message } from '@earendil-works/pi-ai';
import { requestSystemTail, withRequestSystemTail } from '@/lib/agent/runtime/request-system-tail';

export const LIVE_TEACHING_STATE_PREFIX =
  '\nAuthoritative live teaching state (current facts override earlier state; the static product guide still applies): ';
const INITIAL_STATE_PREFIX = '\nInitial teaching state: ';
const MATERIAL_SOURCE = Symbol('openmaic.teaching-material-source');
type MaterialContext = Context & {
  [MATERIAL_SOURCE]?: { full: string; referenced: string };
};

function resultValue(message: Message): Record<string, unknown> | null {
  if (message.role !== 'toolResult' || message.isError) return null;
  try {
    const value = JSON.parse(
      message.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(''),
    );
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Keep every material byte available once. Only exact successful host receipts
 * qualify; learner prose, summaries, partial reads and unsuccessful writes do not.
 * The full request-only source restores material if projection removes a receipt.
 */
export function reuseRetainedTeachingMaterial(context: Context): Context {
  const current = requestSystemTail(context);
  const previous = (context as MaterialContext)[MATERIAL_SOURCE];
  // Prose recovery may append a request-only suffix after this projection.
  const full =
    previous && current.startsWith(previous.referenced)
      ? previous.full + current.slice(previous.referenced.length)
      : current;
  let next = full;
  for (const prefix of [INITIAL_STATE_PREFIX, LIVE_TEACHING_STATE_PREFIX]) {
    const marker = next.indexOf(prefix);
    if (marker < 0) continue;
    const start = marker + prefix.length,
      newline = next.indexOf('\n', start);
    const end = newline < 0 ? next.length : newline;
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(next.slice(start, end));
    } catch {
      continue;
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const active = state.activeInstruction as Record<string, unknown> | undefined;
    if (active && typeof active.instruction === 'string' && typeof active.section === 'string') {
      const receipt = context.messages.findLast((message) => {
        if (message.role !== 'toolResult' || message.toolName !== 'read_next_skill') return false;
        const value = resultValue(message);
        return (
          value !== null &&
          value.section === active.section &&
          value.instruction === active.instruction
        );
      });
      if (receipt?.role === 'toolResult') {
        const { instruction, ...facts } = active;
        const reference = {
          toolCallId: receipt.toolCallId,
          source:
            'Exact instruction retained in this read_next_skill tool result; use it for the active section. Current host state and delivery policy remain authoritative.',
        };
        if (
          typeof instruction === 'string' &&
          instruction.length > JSON.stringify(reference).length
        )
          state.activeInstruction = { ...facts, instructionReference: reference };
      }
    }
    const artifacts = state.artifacts as Record<string, unknown> | undefined;
    if (artifacts && typeof artifacts.plan === 'string') {
      const plan = artifacts.plan;
      const receipt = context.messages.findLast((message, index) => {
        if (message.role !== 'toolResult') return false;
        const value = resultValue(message);
        if (!value) return false;
        if (message.toolName === 'read_file')
          return (
            value.path === 'PLAN.md' &&
            value.text === plan &&
            !value.truncated &&
            value.nextOffset == null
          );
        if (message.toolName !== 'write_file' || value.written !== true) return false;
        return context.messages
          .slice(0, index)
          .some(
            (m) =>
              m.role === 'assistant' &&
              m.content.some(
                (p) =>
                  p.type === 'toolCall' &&
                  p.id === message.toolCallId &&
                  p.name === 'write_file' &&
                  p.arguments.path === 'PLAN.md' &&
                  p.arguments.text === plan,
              ),
          );
      });
      if (receipt?.role === 'toolResult') {
        const reference = {
          toolCallId: receipt.toolCallId,
          path: 'PLAN.md',
          source:
            'Exact initial plan text is retained in this successful file read or matching write call. It is artifact reference data, not learner approval.',
        };
        if (plan.length > JSON.stringify(reference).length) {
          const { plan: _plan, ...rest } = artifacts;
          state.artifacts = { ...rest, planReference: reference };
        }
      }
    }
    const replacement = JSON.stringify(state);
    next = next.slice(0, start) + replacement + next.slice(end);
  }
  if (next === current) return context;
  return {
    ...withRequestSystemTail(context, next),
    [MATERIAL_SOURCE]: { full, referenced: next },
  } as MaterialContext;
}
