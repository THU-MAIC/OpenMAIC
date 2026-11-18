// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/workbench/panel-context', () => ({ useInWorkbenchPanel: () => false }));
vi.mock('@/components/stage/scene-renderer', () => ({ SceneRenderer: () => null }));
vi.mock('@/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/whiteboard', () => ({ Whiteboard: () => null }));
vi.mock('@/components/canvas/canvas-toolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('@/components/canvas/slide-element-pick-overlay', () => ({
  SlideElementPickOverlay: () => null,
}));

import { CanvasArea } from '@/components/canvas/canvas-area';

describe('Phone navigation without a completed scene', () => {
  it.each(['waiting', 'failed', 'interrupted'] as const)(
    'recovers Back after controls auto-hide while generation is %s',
    (phase) => {
      vi.useFakeTimers();
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const back = vi.fn();
      try {
        act(() => {
          root.render(
            createElement(CanvasArea, {
              mobile: true,
              currentScene: null,
              currentSceneIndex: 0,
              scenesCount: 0,
              mode: 'playback',
              engineState: 'idle',
              whiteboardOpen: false,
              isPendingScene: true,
              isGenerationFailed: phase !== 'waiting',
              isGenerationInterrupted: phase === 'interrupted',
              mobileCourseName: 'A course being built',
              onMobileBack: back,
              onPlayPause: vi.fn(),
              onPrevSlide: vi.fn(),
              onNextSlide: vi.fn(),
              onWhiteboardClose: vi.fn(),
            }),
          );
        });
        act(() => vi.advanceTimersByTime(2100));
        const chrome = host.querySelector('.mobile-canvas-chrome')!;
        expect(chrome.getAttribute('data-visible')).toBe('false');
        const recovery = host.querySelector<HTMLButtonElement>(
          'button[aria-label="mobileClassroom.controls"]',
        );
        expect(recovery).not.toBeNull();
        act(() => recovery!.click());
        expect(chrome.getAttribute('data-visible')).toBe('true');
        act(() => host.querySelector<HTMLButtonElement>('.mobile-canvas-header button')!.click());
        expect(back).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        host.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});
