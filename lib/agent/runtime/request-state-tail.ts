import type { Context } from '@earendil-works/pi-ai';

// Host-only request metadata: never a Pi learner message, transcript entry or JSON field.
// The connector alone renders it as the last wire-only user message.
// An enumerable symbol survives request projection spreads without being persisted.
const STATE_TAIL = Symbol('openmaic.request-state-tail');
type RequestContext = Context & { [STATE_TAIL]?: string };

export function requestStateTail(context: Context): string {
  return (context as RequestContext)[STATE_TAIL] ?? '';
}

export function withRequestStateTail(context: Context, tail: string): Context {
  return { ...context, [STATE_TAIL]: tail } as RequestContext;
}

export function appendRequestStateTail(context: Context, tail: string): Context {
  const previous = requestStateTail(context);
  return withRequestStateTail(context, [previous, tail].filter(Boolean).join('\n'));
}
