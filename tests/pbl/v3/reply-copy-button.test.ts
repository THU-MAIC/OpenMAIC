// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReplyCopyButton } from '@/components/scene-renderers/pbl/v3/reply-copy-button';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it('retries failed copies and locks each successful copy for its own 1.6 seconds', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const pending = Promise.withResolvers<void>();
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error('Denied'))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ReplyCopyButton, { text: 'First reply' })));
    const button = host.querySelector('button')!;
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    await act(async () => button.click());
    expect(button.getAttribute('aria-disabled')).toBe('false');
    await act(async () => {
      button.click();
      button.click();
    });
    await tick(2000);
    expect(writeText).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve());
    expect(button.textContent).toBe('workbench.chat.copied');
    await tick(1599);
    await act(async () => button.click());
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(writeText).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(button.getAttribute('aria-label')).toBe('workbench.chat.copyReply');

    await act(async () => root.render(createElement(ReplyCopyButton, { text: 'Updated reply' })));
    await act(async () => button.click());
    expect(writeText).toHaveBeenLastCalledWith('Updated reply');
    await tick(1599);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await tick(1);
    expect(button.getAttribute('aria-disabled')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
