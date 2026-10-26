// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const mocks = vi.hoisted(() => ({ container: null as HTMLElement | null }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: unknown;
  }) =>
    open
      ? createElement(
          'div',
          null,
          createElement('button', { onClick: () => onOpenChange(false) }, 'close'),
          children as never,
        )
      : null,
  DialogContent: ({
    children,
    container,
  }: {
    children: unknown;
    container: HTMLElement | null;
  }) => {
    mocks.container = container;
    return createElement('div', null, children as never);
  },
  DialogTitle: ({ children }: { children: unknown }) =>
    createElement('h2', null, children as never),
  DialogDescription: ({ children }: { children: unknown }) =>
    createElement('p', null, children as never),
}));
import { ConversationHistory } from '@/components/scene-renderers/pbl/v3/conversation-history';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());

it('loads only on demand, freezes the cursor across SSE changes and preserves earlier pages on errors', async () => {
  const requests: { url: URL; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, options: { signal: AbortSignal }) =>
        new Promise<Response>((resolve) =>
          requests.push({ url: new URL(url, 'http://localhost'), signal: options.signal, resolve }),
        ),
    ),
  );
  const container = document.createElement('div');
  container.dataset.pblV3Portal = '';
  const root = createRoot(container);
  const render = (through: number) =>
    root.render(
      createElement(ConversationHistory, {
        id: 'study',
        sources: [{ sessionId: 'coder', through, role: 'coder' }],
        renderEntry: (entry) => createElement('p', null, entry.id),
      }),
    );
  const click = async (label: string) =>
    act(async () => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === label,
      );
      if (!button) throw new Error(`Missing ${label}`);
      button.click();
    });
  try {
    await act(async () => render(100));
    expect(requests).toHaveLength(0);
    await click('pblV3.history.title');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(requests).toHaveLength(1);
    expect(mocks.container).toBe(container);
    expect(requests[0].url.searchParams.get('through')).toBe('100');
    await act(async () =>
      requests[0].resolve(
        Response.json({ through: 100, nextBefore: 50, conversation: [{ id: 'newer' }] }),
      ),
    );
    expect(container.textContent).toContain('newer');
    await act(async () => render(200));
    expect(requests).toHaveLength(1);
    expect(container.textContent).toContain('newer');
    await click('pblV3.history.older');
    expect(requests[1].url.searchParams.get('through')).toBe('100');
    expect(requests[1].url.searchParams.get('before')).toBe('50');
    await act(async () => requests[1].resolve(new Response('', { status: 503 })));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('newer');
    await click('common.retry');
    await act(async () =>
      requests[2].resolve(
        Response.json({ through: 100, nextBefore: null, conversation: [{ id: 'older' }] }),
      ),
    );
    expect(container.textContent!.indexOf('older')).toBeLessThan(
      container.textContent!.indexOf('newer'),
    );
    await click('close');
    await click('pblV3.history.title');
    expect(requests[3].url.searchParams.get('through')).toBe('200');
    await click('close');
    expect(requests[3].signal.aborted).toBe(true);
    await act(async () =>
      requests[3].resolve(
        Response.json({ through: 200, nextBefore: null, conversation: [{ id: 'late' }] }),
      ),
    );
    expect(container.textContent).not.toContain('late');
  } finally {
    await act(async () => root.unmount());
  }
});
