import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThinkingConfig } from '@/lib/types/provider';

const globalRecord = globalThis as Record<string, unknown>;
let previousContext: unknown;

beforeEach(() => {
  previousContext = globalRecord.__thinkingContext;
  delete globalRecord.__thinkingContext;
  vi.resetModules();
});

afterEach(() => {
  if (previousContext === undefined) {
    delete globalRecord.__thinkingContext;
  } else {
    globalRecord.__thinkingContext = previousContext;
  }
  vi.resetModules();
});

describe('thinking context across module instances', () => {
  it('keeps an in-flight call visible when another bundle evaluates the module', async () => {
    const { thinkingContext: original } = await import('@/lib/ai/thinking-context');
    const config: ThinkingConfig = { mode: 'disabled' };

    const reloaded = await original.run(config, async () => {
      vi.resetModules();
      const { thinkingContext } = await import('@/lib/ai/thinking-context');
      await Promise.resolve();

      expect(thinkingContext.getStore()).toBe(config);
      const providerContext = globalRecord.__thinkingContext as typeof thinkingContext;
      expect(providerContext.getStore()).toBe(config);
      return thinkingContext;
    });

    expect(reloaded).toBe(original);
    expect(original.getStore()).toBeUndefined();
    expect(reloaded.getStore()).toBeUndefined();
  });

  it('isolates concurrent calls made through separately evaluated exports', async () => {
    const { thinkingContext: original } = await import('@/lib/ai/thinking-context');
    vi.resetModules();
    const { thinkingContext: reloaded } = await import('@/lib/ai/thinking-context');
    const disabled: ThinkingConfig = { mode: 'disabled' };
    const enabled: ThinkingConfig = { mode: 'enabled' };
    const observed = await Promise.all([
      original.run(disabled, async () => {
        await Promise.resolve();
        return reloaded.getStore();
      }),
      reloaded.run(enabled, async () => {
        await Promise.resolve();
        return original.getStore();
      }),
    ]);

    expect(observed).toEqual([disabled, enabled]);
    expect(original.getStore()).toBeUndefined();
    expect(reloaded.getStore()).toBeUndefined();
  });
});
