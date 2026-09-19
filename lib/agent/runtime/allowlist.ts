import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';

/** v0 capability restriction = tool allowlist (NOT a hardcoded workflow).
 *  Widening capability = adding a name here. */
export function makeAllowlistGate(allowed: ReadonlySet<string>) {
  return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    if (allowed.has(ctx.toolCall.name)) return undefined;
    return { block: true, reason: `Tool "${ctx.toolCall.name}" is not enabled in this build.` };
  };
}
