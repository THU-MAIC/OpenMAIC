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

import type { Scene } from '@/lib/types/stage';

import { CanvasArea } from '@/components/canvas/canvas-area';

describe('Phone control recovery', () => {
  it.each(['waiting', 'failed', 'interrupted', 'video'] as const)(
    'recovers Back after controls auto-hide in the %s state',
    (phase) => {
      vi.useFakeTimers();
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const back = vi.fn();
      const playPause = vi.fn();
      const videoScene: Scene = {
        id: 'video',
        stageId: 'course',
        type: 'slide',
        title: 'Video lesson',
        order: 0,
        createdAt: 0,
        updatedAt: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'video-canvas',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#fff',
              themeColors: [],
              fontColor: '#000',
              fontName: 'Arial',
            },
            elements: [
              {
                id: 'video',
                type: 'video',
                src: '/video.mp4',
                autoplay: false,
                left: 0,
                top: 0,
                width: 1000,
                height: 562.5,
                rotate: 0,
              },
            ],
          },
        },
      };
      try {
        act(() => {
          root.render(
            createElement(CanvasArea, {
              mobile: true,
              currentScene: phase === 'video' ? videoScene : null,
              currentSceneIndex: 0,
              scenesCount: 0,
              mode: 'playback',
              engineState: 'idle',
              whiteboardOpen: false,
              isPendingScene: phase !== 'video',
              isGenerationFailed: phase === 'failed',
              isGenerationInterrupted: phase === 'interrupted',
              mobileCourseName: 'A course being built',
              onMobileBack: back,
              onPlayPause: playPause,
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
        expect(playPause).not.toHaveBeenCalled();
        act(() => host.querySelector<HTMLButtonElement>('.mobile-canvas-header button')!.click());
        expect(back).toHaveBeenCalledOnce();
        expect(playPause).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        host.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});
