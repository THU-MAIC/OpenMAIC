import type { Context } from '@earendil-works/pi-ai';

// Host-only request metadata: not a learner message, transcript entry or JSON field.
// An enumerable symbol survives request projection spreads without being persisted.
const SYSTEM_TAIL = Symbol('openmaic.request-system-tail');
type RequestContext = Context & { [SYSTEM_TAIL]?: string };

export function requestSystemTail(context: Context): string {
  return (context as RequestContext)[SYSTEM_TAIL] ?? '';
}

export function withRequestSystemTail(context: Context, tail: string): Context {
  return { ...context, [SYSTEM_TAIL]: tail } as RequestContext;
}

export function appendRequestSystemTail(context: Context, tail: string): Context {
  const previous = requestSystemTail(context);
  return withRequestSystemTail(context, [previous, tail].filter(Boolean).join('\n'));
}
