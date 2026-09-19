// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InteractiveRenderer } from '@/components/scene-renderers/interactive-renderer';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const content = { type: 'interactive' as const, html: '<main id="experiment">1000</main>' };
const pool = () => useInteractiveIframePool.getState();
let host: HTMLDivElement;

beforeEach(() => {
  pool().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => host.remove());

/**
 * #619 keep-alive: a placeholder unmount/remount for the same scene and the same
 * authored HTML must reuse the pooled document. If it does not, the iframe gets a
 * new `srcDoc` and reloads, discarding whatever the student had set.
 */
it('reuses the pooled document and reader identity across a real unmount/remount', async () => {
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(InteractiveRenderer, { sceneId: 's1', content }));
  });
  const first = pool().entries['s1'];
  expect(first.srcDoc).toBeDefined();

  // A genuine unmount, then a fresh mount of an equivalent placeholder — what the
  // Stage mode cross-fade does. Every React instance value is rebuilt here.
  await act(async () => root.unmount());
  const remounted = createRoot(host);
  await act(async () => {
    remounted.render(
      createElement(InteractiveRenderer, { sceneId: 's1', content: { ...content } }),
    );
  });

  const second = pool().entries['s1'];
  expect(second.srcDoc).toBe(first.srcDoc);
  expect(second.observationIdentity).toBe(first.observationIdentity);
  expect(second.observationIdentity?.documentId).toBe(first.observationIdentity?.documentId);
  await act(async () => remounted.unmount());
});

it('rebuilds the document and mints a new identity when the content changes', async () => {
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(InteractiveRenderer, { sceneId: 's1', content }));
  });
  const first = pool().entries['s1'];
  await act(async () => {
    root.render(
      createElement(InteractiveRenderer, {
        sceneId: 's1',
        content: { ...content, html: '<main id="experiment">1400</main>' },
      }),
    );
  });
  const second = pool().entries['s1'];
  expect(second.srcDoc).not.toBe(first.srcDoc);
  expect(second.observationIdentity?.documentId).not.toBe(first.observationIdentity?.documentId);
  await act(async () => root.unmount());
});
