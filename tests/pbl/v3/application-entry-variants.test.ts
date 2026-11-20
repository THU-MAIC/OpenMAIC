// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/scene-renderers/pbl/v3/request', () => ({ pblRequest: mocks.request }));
import { ApplicationPreview } from '@/components/scene-renderers/pbl/v3/application-preview';
import { useApplicationPreview } from '@/components/scene-renderers/pbl/v3/use-application-preview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const view = {
  id: 'study',
  environmentId: 'environment',
  busy: false,
  revision: 0,
  environment: { ready: true },
  application: { title: 'Preview', description: 'Try it' },
} as LearningView;
const workbench = { environmentId: 'environment', epoch: 0 } as LearningWorkbench;
let host: HTMLDivElement, root: Root;
function Harness({ dirty = false, inputPaused = false }) {
  const preview = useApplicationPreview(view, workbench, dirty, true);
  return createElement(ApplicationPreview, {
    application: view.application!,
    preview,
    inputPaused,
  });
}
async function render(props = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mocks.request.mockResolvedValue({
    state: 'running',
    observedAt: '',
    sourceChanged: false,
    preview: {
      url: 'https://isolated.example/__openmaic_preview',
      expiresAt: Date.now() + 300_000,
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  mocks.request.mockReset();
  vi.restoreAllMocks();
});

it.each(['dirty', 'modal'] as const)(
  'accepts first shell readiness during %s input suspension and resumes the same document',
  async (suspension) => {
    await render();
    const frame = host.querySelector('iframe')!;
    const source = frame.contentWindow;
    const src = frame.src;
    const input = vi.spyOn(source!, 'postMessage');
    await render(suspension === 'dirty' ? { dirty: true } : { inputPaused: true });
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source,
          origin: 'https://isolated.example',
          data: { type: 'openmaic-preview-ready' },
        }),
      ),
    );
    expect(host.querySelector('iframe')).toBe(frame);
    expect(frame.className).not.toContain('invisible');
    expect(frame.hasAttribute('inert')).toBe(true);
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source,
          origin: 'https://isolated.example',
          data: { type: 'openmaic-preview-input-request' },
        }),
      ),
    );
    expect(input).toHaveBeenLastCalledWith(
      { type: 'openmaic-preview-input', enabled: false },
      'https://isolated.example',
    );
    await render();
    expect(host.querySelector('iframe')).toBe(frame);
    expect(frame.contentWindow).toBe(source);
    expect(frame.src).toBe(src);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(input).toHaveBeenLastCalledWith(
      { type: 'openmaic-preview-input', enabled: true },
      'https://isolated.example',
    );
    const actions = mocks.request.mock.calls.map(([, body]) => body.action);
    expect(actions.filter((action) => action === 'open')).toHaveLength(1);
    expect(actions).not.toContain('restart');
  },
);
