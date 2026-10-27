// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  finish: undefined as (() => void) | undefined,
  submissions: 0,
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: (select: (state: unknown) => unknown) => select({ stage: { id: 'course' } }),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/scene-renderers/pbl/project-hero', () => ({
  ProjectHero: ({ onStart }: { onStart: () => void }) =>
    createElement('button', { onClick: onStart }, 'Start'),
}));
vi.mock('@/components/scene-renderers/pbl/workspace-layer', () => ({
  PBLWorkspaceLayer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/pbl/v3/event-stream', async (original) => ({
  ...(await original<typeof import('@/lib/pbl/v3/event-stream')>()),
  readLearningStream: mocks.read,
}));
vi.mock('@/components/scene-renderers/pbl/v3/workspace', () => ({
  pblRequest: async () => ({ hero: {}, started: false }),
  PBLV3Workspace: function Workspace() {
    useLearningStream('study', () => {});
    const [pending, setPending] = useState(false);
    return createElement(
      'button',
      {
        'data-testid': 'workspace-submit',
        disabled: pending,
        onClick: () => {
          mocks.submissions++;
          setPending(true);
          mocks.finish = () => setPending(false);
        },
      },
      pending ? 'Pending' : 'Submit',
    );
  },
}));
import { useLearningStream } from '@/components/scene-renderers/pbl/v3/use-learning-stream';
import { PBLV3Container } from '@/components/scene-renderers/pbl/v3/project-entry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.finish = undefined;
  mocks.submissions = 0;
});

it.each([false, true])(
  'preserves the workspace, stream and pending submission through native fullscreen (initial: %s)',
  async (initialFullscreen) => {
    const page = document.createElement('div');
    const stage = document.createElement('div');
    document.body.append(page, stage);
    let fullscreen: Element | null = initialFullscreen ? stage : null;
    const originalFullscreen = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreen,
    });
    mocks.read.mockImplementation(() => new Promise(() => {}));
    const root = createRoot(page);
    try {
      await act(async () => root.render(createElement(PBLV3Container, { sceneId: 'scene' })));
      await act(async () => page.querySelector('button')!.click());
      const submit = document.querySelector<HTMLButtonElement>('[data-testid="workspace-submit"]')!;
      const portalHost = submit.parentElement!;
      expect(portalHost.parentElement).toBe(initialFullscreen ? stage : document.body);
      await act(async () => submit.click());
      expect(submit.disabled).toBe(true);
      expect(mocks.read).toHaveBeenCalledTimes(1);
      const signal = mocks.read.mock.calls[0]![1] as AbortSignal;
      for (const target of [stage, null, stage, null]) {
        await act(async () => {
          fullscreen = target;
          document.dispatchEvent(new Event('fullscreenchange'));
        });
        expect(document.querySelector('[data-testid="workspace-submit"]')).toBe(submit);
        expect(portalHost.parentElement).toBe(target ?? document.body);
        expect(submit.disabled).toBe(true);
        expect(mocks.read).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(false);
        submit.click();
        expect(mocks.submissions).toBe(1);
      }
      await act(async () => mocks.finish!());
      expect(submit.disabled).toBe(false);
      await act(async () => root.unmount());
      expect(signal.aborted).toBe(true);
      expect(portalHost.isConnected).toBe(false);
    } finally {
      await act(async () => root.unmount());
      page.remove();
      stage.remove();
      if (originalFullscreen)
        Object.defineProperty(document, 'fullscreenElement', originalFullscreen);
      else Reflect.deleteProperty(document, 'fullscreenElement');
    }
  },
);
