import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneProvider, type SceneDataController } from '@/lib/contexts/scene-context';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import {
  RendererScreenCanvas,
  getPlaybackImageState,
} from '@/components/slide-renderer/Editor/RendererScreenCanvas';
import type { SlideContent } from '@/lib/types/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

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

describe('RendererScreenCanvas', () => {
  beforeEach(() => {
    useMediaGenerationStore.setState({ tasks: {} });
  });

  afterEach(() => {
    setModelSettingsViewForTests(null);
  });

  it('renders playback through @openmaic/renderer', () => {
    const html = renderToStaticMarkup(
      createElement(
        TestSceneProvider,
        { controller: controller as SceneDataController },
        createElement(RendererScreenCanvas),
      ),
    );

    expect(html).toContain('class="slide-element"');
    expect(html).toContain('id="screen-element-title-1"');
  });

  it('keeps shape-label padding and paragraph spacing in playback', () => {
    const shapeController: SceneDataController<SlideContent> = {
      ...controller,
      getSnapshot: () => ({
        ...content,
        canvas: {
          ...content.canvas,
          elements: [
            {
              id: 'shape-1',
              type: 'shape',
              left: 24,
              top: 32,
              width: 160,
              height: 100,
              rotate: 0,
              path: 'M0 0 L160 0 L160 100 Z',
              viewBox: [160, 100],
              fixedRatio: false,
              fill: '#eeeeee',
              text: {
                content: '<p>First</p><p>Second</p>',
                align: 'middle',
                defaultFontName: 'Arial',
                defaultColor: '#111111',
                paragraphSpace: 12,
              },
            },
          ],
        },
      }),
    };

    const html = renderToStaticMarkup(
      createElement(
        TestSceneProvider,
        { controller: shapeController as SceneDataController },
        createElement(RendererScreenCanvas),
      ),
    );
    const { document } = parseHTML(html);
    const label = document.querySelector('.shape-text');
    const prose = document.querySelector('.shape-text .slide-renderer-prose');
    expect(label?.getAttribute('style')).toContain('padding:10px');
    expect(label?.getAttribute('style')).toContain('line-height:1.625');
    expect(prose?.getAttribute('style')).toContain('--paragraphSpace:12px');
    expect(document.querySelector('style')?.textContent).toContain('.slide-renderer-prose p');
  });

  it('renders playback videos inline for mobile browsers', () => {
    const videoContent: SlideContent = {
      ...content,
      canvas: {
        ...content.canvas,
        elements: [
          {
            id: 'video-1',
            type: 'video',
            left: 24,
            top: 32,
            width: 320,
            height: 180,
            rotate: 0,
            src: 'video.mp4',
            autoplay: false,
          },
        ],
      },
    };
    const videoController: SceneDataController<SlideContent> = {
      ...controller,
      getSnapshot: () => videoContent,
    };

    const html = renderToStaticMarkup(
      createElement(
        TestSceneProvider,
        { controller: videoController as SceneDataController },
        createElement(RendererScreenCanvas),
      ),
    );

    expect(html).toMatch(/<video[^>]*playsinline/i);
  });

  // With image generation off — the default — an untracked generated
  // placeholder is a slide whose media will not arrive, and that is what it
  // says. It briefly claimed to be pending only because asking the asset pool
  // about the placeholder left a lease in flight during the first paint; the
  // pool never held such a ref, so it is no longer asked.
  it('renders an untracked generated placeholder as disabled when generation is off', () => {
    // The workspace's image slot resolves to nothing.
    setModelSettingsViewForTests({});
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
          createElement(RendererScreenCanvas),
        ),
      ),
    );

    expect(html).toContain('data-media-state="disabled"');
    expect(html).not.toContain('src="gen_img_1"');
  });

  it('renders a completed generated image with the renderer default image treatment', () => {
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
          createElement(RendererScreenCanvas),
        ),
      ),
    );

    expect(html).toContain('src="blob:generated-image"');
    expect(html).toContain('background-color:#ff0000');
  });

  it('classifies generated-image pending, failed, and retryable states', () => {
    expect(getPlaybackImageState({ kind: 'pending' })).toBe('pending');
    expect(getPlaybackImageState({ kind: 'placeholder' })).toBe('pending');
    expect(getPlaybackImageState({ kind: 'failed', retryable: true })).toBe('failed');
    expect(getPlaybackImageState({ kind: 'raw', value: 'logo.png' })).toBe('ready');
    expect(getPlaybackImageState({ kind: 'url', url: 'blob:image' })).toBe('ready');
  });
});
