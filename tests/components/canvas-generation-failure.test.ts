// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasArea } from '@/components/canvas/canvas-area';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const pending: ComponentProps<typeof CanvasArea> = {
  currentScene: null,
  mode: 'playback',
  currentSceneIndex: 1,
  scenesCount: 2,
  engineState: 'idle',
  whiteboardOpen: false,
  hideToolbar: true,
  isPendingScene: true,
  onPrevSlide: () => {},
  onNextSlide: () => {},
  onPlayPause: () => {},
  onWhiteboardClose: () => {},
};

async function render(patch: Partial<ComponentProps<typeof CanvasArea>>) {
  if (!root) {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(createElement(CanvasArea, { ...pending, ...patch })));
}

describe('the classroom generation failure', () => {
  it('shows quota guidance in the existing failure card and retains Retry', async () => {
    let retried = false;
    await render({
      isGenerationFailed: true,
      generationFailureMessage: 'Generation quota exhausted. Check your plan before retrying.',
      onRetryGeneration: () => {
        retried = true;
      },
    });

    expect(document.body.textContent).toContain(
      'Generation quota exhausted. Check your plan before retrying.',
    );
    expect(document.body.textContent).not.toContain('stage.generationFailed');
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'generation.retryScene',
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(retried).toBe(true);

    await render({ isGenerationFailed: false });
    expect(document.body.textContent).not.toContain('Generation quota exhausted.');
    expect(document.body.textContent).not.toContain('generation.retryScene');
  });

  it('keeps the generic failure message when there is no quota guidance', async () => {
    await render({ isGenerationFailed: true });
    expect(document.body.textContent).toContain('stage.generationFailed');
  });
});
