// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import zh from '@/lib/i18n/locales/zh-CN.json';
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (value, part) =>
            value && typeof value === 'object'
              ? (value as Record<string, unknown>)[part]
              : undefined,
          zh,
        );
      return typeof value === 'string' ? value : key;
    },
  }),
}));
import { TeachingRunNotice } from '@/components/scene-renderers/pbl/v3/teaching-run-notice';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('makes recovery explicit, retains the actual failure message, and never retries automatically', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    onRetry = vi.fn();
  const props = {
    run: { status: 'failed', canRetry: true, failure: 'unavailable' },
    disabled: false,
    onRetry,
  } as const;
  try {
    await act(async () => root.render(createElement(TeachingRunNotice, props)));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector('h4')!.textContent).toBe('这轮回复暂未完成');
    expect(host.textContent).toContain('你的消息和学习记录已保留。');
    expect(host.textContent).toContain(zh.pblV3.run.unavailable);
    expect(onRetry).not.toHaveBeenCalled();
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe('重试本轮回复');
    await act(async () => button.click());
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(createElement(TeachingRunNotice, { ...props, retrying: true })),
    );
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('正在重试…');
    await act(async () => button.click());
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        createElement(TeachingRunNotice, { ...props, disabled: true, blockedReason: 'stream' }),
      ),
    );
    expect(button.disabled).toBe(true);
    await act(async () =>
      root.render(
        createElement(TeachingRunNotice, { ...props, run: { ...props.run, canRetry: false } }),
      ),
    );
    expect(host.querySelector('button')).toBeNull();
    await act(async () =>
      root.render(
        createElement(TeachingRunNotice, { ...props, run: { ...props.run, status: 'succeeded' } }),
      ),
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
