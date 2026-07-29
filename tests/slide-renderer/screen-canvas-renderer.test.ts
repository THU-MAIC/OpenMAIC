import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneProvider, type SceneDataController } from '@/lib/contexts/scene-context';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { PlaybackScreenCanvas } from '@/components/slide-renderer/Editor/ScreenCanvas';
import { getPlaybackImageState } from '@/components/slide-renderer/Editor/RendererScreenCanvas';
import type { SlideContent } from '@/lib/types/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const content: SlideContent = {
  type: 'slide',
  canvas: {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#ffffff' },
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [
      {
        id: 'title-1',
        type: 'text',
        left: 24,
        top: 32,
        width: 120,
        height: 48,
        rotate: 0,
        content: '<p>Hello</p>',
        defaultFontName: 'Arial',
        defaultColor: '#111111',
      },
    ],
  },
};

const controller: SceneDataController<SlideContent> = {
  sceneId: 'scene-1',
  sceneType: 'slide',
  getSnapshot: () => content,
  updateSceneData: () => {},
};

const TestSceneProvider = SceneProvider as ComponentType<{
  controller?: SceneDataController;
  children?: ReactNode;
}>;

describe('PlaybackScreenCanvas', () => {
  const flag = 'NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
    useMediaGenerationStore.setState({ tasks: {} });
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = original;
    }
  });

  it('uses the legacy playback renderer by default', () => {
    delete process.env[flag];

    const html = renderToStaticMarkup(
      createElement(
        TestSceneProvider,
        { controller: controller as SceneDataController },
        createElement(PlaybackScreenCanvas),
      ),
    );

    expect(html).toContain('class="screen-element"');
    expect(html).toContain('id="screen-element-title-1"');
    expect(html).not.toContain('class="slide-element"');
  });

  it('uses @openmaic/renderer when the playback renderer flag is enabled', () => {
    process.env[flag] = 'true';
    const html = renderToStaticMarkup(
      createElement(
        TestSceneProvider,
        { controller: controller as SceneDataController },
        createElement(PlaybackScreenCanvas),
      ),
    );

    expect(html).toContain('class="slide-element"');
    expect(html).toContain('id="screen-element-title-1"');
  });

  it('keeps generated-image status UI in renderer playback mode', () => {
    process.env[flag] = 'true';
    const imageContent: SlideContent = {
      ...content,
      canvas: {
        ...content.canvas,
        elements: [
          {
            id: 'image-1',
            type: 'image',
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            rotate: 0,
            fixedRatio: true,
            src: 'gen_img_1',
          },
        ],
      },
    };
    const imageController: SceneDataController<SlideContent> = {
      ...controller,
      getSnapshot: () => imageContent,
    };

    const html = renderToStaticMarkup(
      createElement(
        MediaStageProvider,
        { value: 'stage-1' },
        createElement(
          TestSceneProvider,
          { controller: imageController as SceneDataController },
          createElement(PlaybackScreenCanvas),
        ),
      ),
    );

    expect(html).toContain('data-media-state="disabled"');
  });

  it('renders a completed generated image with the renderer default image treatment', () => {
    process.env[flag] = 'true';
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_1: {
          elementId: 'gen_img_1',
          type: 'image',
          status: 'done',
          prompt: '',
          params: {},
          objectUrl: 'blob:generated-image',
          retryCount: 0,
          stageId: 'stage-1',
        },
      },
    });
    const imageContent: SlideContent = {
      ...content,
      canvas: {
        ...content.canvas,
        elements: [
          {
            id: 'image-1',
            type: 'image',
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            rotate: 0,
            fixedRatio: true,
            src: 'gen_img_1',
            colorMask: '#ff0000',
          },
        ],
      },
    };
    const imageController: SceneDataController<SlideContent> = {
      ...controller,
      getSnapshot: () => imageContent,
    };

    const html = renderToStaticMarkup(
      createElement(
        MediaStageProvider,
        { value: 'stage-1' },
        createElement(
          TestSceneProvider,
          { controller: imageController as SceneDataController },
          createElement(PlaybackScreenCanvas),
        ),
      ),
    );

    expect(html).toContain('src="blob:generated-image"');
    expect(html).toContain('background-color:#ff0000');
  });

  it('classifies generated-image pending, failed, and retryable states', () => {
    const pendingTask = {
      elementId: 'gen_img_1',
      type: 'image' as const,
      status: 'pending' as const,
      prompt: '',
      params: {},
      retryCount: 0,
      stageId: 'stage-1',
    };

    expect(getPlaybackImageState(true, pendingTask, true)).toBe('pending');
    expect(
      getPlaybackImageState(true, { ...pendingTask, status: 'failed', error: 'failed' }, true),
    ).toBe('failed');
    expect(getPlaybackImageState(true, undefined, false)).toBe('disabled');
    expect(getPlaybackImageState(false, undefined, false)).toBe('ready');
  });
});
