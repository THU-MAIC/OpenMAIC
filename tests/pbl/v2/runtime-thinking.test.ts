import { describe, it, expect } from 'vitest';

import { thinkingContext } from '@/lib/ai/thinking-context';
import { withThinkingDisabled } from '@/lib/pbl/v2/agents/runtime-thinking';

/**
 * #669: PBL v2 runtime LLM calls must run with thinking disabled so a pinned
 * model whose thinking defaults on (e.g. DeepSeek) doesn't reject the forced
 * `begin_turn` tool_choice. The provider fetch wrapper reads the disabled
 * config from this AsyncLocalStorage, so the contract is "the store reads
 * disabled inside the wrapped call".
 */
describe('withThinkingDisabled (#669)', () => {
  it('seeds the thinking AsyncLocalStorage with a disabled config', () => {
    const seen = withThinkingDisabled(() => thinkingContext.getStore());
    expect(seen).toEqual({ mode: 'disabled', enabled: false });
  });

  it('returns the wrapped callable result (so streamText/generateText pass through)', () => {
    const result = withThinkingDisabled(() => 'sentinel');
    expect(result).toBe('sentinel');
  });

  it('does not leak the disabled config outside the wrapped call', () => {
    withThinkingDisabled(() => undefined);
    expect(thinkingContext.getStore()).toBeUndefined();
  });
});
