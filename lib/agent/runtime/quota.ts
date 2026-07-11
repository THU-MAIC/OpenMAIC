import type { AfterToolCallContext, AfterToolCallResult } from '@earendil-works/pi-agent-core';

/** Budget source — v0 stub; wire to the credit/quota system later. */
export interface QuotaSource {
  remaining(): number;
}

export function makeQuotaHook(source: QuotaSource) {
  return async (_ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    if (source.remaining() <= 0) return { terminate: true };
    return undefined;
  };
}
