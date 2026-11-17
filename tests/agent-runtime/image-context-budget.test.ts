import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  estimateFullContextTokens,
  IMAGE_BLOCK_TOKEN_BUDGET,
  IMAGE_PROTOCOL_TOKEN_BUDGET,
} from '@/lib/agent/runtime/compaction-runtime';

describe('native image admission estimate', () => {
  const estimate = (size: number, count = 1, text = '') =>
    estimateFullContextTokens({
      messages: [
        {
          role: 'user',
          timestamp: 1,
          content: [
            { type: 'text', text },
            ...Array.from({ length: count }, () => ({
              type: 'image',
              data: 'a'.repeat(size),
              mimeType: 'image/png',
            })),
          ],
        },
      ] as AgentMessage[],
    });
  it('is independent of encoded image byte length without deleting actual content', () => {
    expect(estimate(100)).toBe(estimate(1_000_000));
  });
  it('counts every image block and protocol overhead', () => {
    expect(estimate(100, 2) - estimate(100, 1)).toBeGreaterThanOrEqual(
      IMAGE_BLOCK_TOKEN_BUDGET + IMAGE_PROTOCOL_TOKEN_BUDGET,
    );
    expect(estimate(100, 1, 'x'.repeat(4000)) - estimate(100)).toBe(1000);
  });
  it('continues counting base64-like plain text and static system/tool context', () => {
    const input = {
      messages: [{ role: 'user', timestamp: 1, content: 'a'.repeat(40_000) }] as AgentMessage[],
    };
    expect(estimateFullContextTokens(input)).toBeGreaterThan(10_000);
    expect(
      estimateFullContextTokens({
        ...input,
        systemPrompt: 'x'.repeat(4000),
        tools: [{ description: 'x'.repeat(4000) }],
      }),
    ).toBeGreaterThan(12_000);
  });
});
