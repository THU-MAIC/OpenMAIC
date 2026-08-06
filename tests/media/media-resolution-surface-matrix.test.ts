import { createElement } from 'react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PPTImageElement, PPTVideoElement, Slide } from '@openmaic/dsl';
import {
  resolveImageSrc,
  useResolvedImageSrc,
} from '@/components/slide-renderer/components/element/ImageElement/useResolvedImageSrc';
import { BaseVideoElement } from '@/components/slide-renderer/components/element/VideoElement/BaseVideoElement';
import { VideoElement } from '@/components/slide-renderer/components/element/VideoElement';
import { resolveSlideMediaState } from '@/components/slide-renderer/use-resolved-slide';
import { useResolvedVideoMedia } from '@/components/slide-renderer/components/element/VideoElement/useResolvedVideoMedia';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { resolvePptxMediaBinding } from '@/lib/export/use-export-pptx';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  mediaResolutionCanRetry,
  renderableMediaUrl,
  resolveMediaRef,
  type MediaResolution,
  type MediaTaskState,
} from '@/lib/media/resolve-media-ref';
import type { AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import type { MediaTask } from '@/lib/store/media-generation';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { resolveThumbnailMediaValue } from '@/lib/utils/stage-storage';
import { resolveVideoExportMediaBinding } from '@/lib/video-export-app/collect';
import { resolveActionVideoMedia } from '@/lib/action/engine';
import type { StageStore } from '@/lib/api/stage-api';

const stageId = 'stage-matrix';
const posterRef = 'ast_video_poster';
const posterLease = { status: 'resolved', url: 'blob:poster' } satisfies AssetUrlLeaseState;

const hookLeases = vi.hoisted(() => ({
  current: {} as Record<string, AssetUrlLeaseState>,
}));
const componentStores = vi.hoisted(() => ({
  media: { tasks: {} as Record<string, MediaTask> },
  settings: { imageGenerationEnabled: false, videoGenerationEnabled: false },
}));

vi.mock('@/lib/media/use-asset-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/use-asset-url')>();
  return {
    ...actual,
    useAssetUrlLease: (ref: string | undefined) =>
      ref ? (hookLeases.current[ref] ?? { status: 'missing' }) : { status: 'pending' },
  };
});

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/store/media-generation', () => {
  const useMediaGenerationStore = Object.assign(
    (selector: (state: typeof componentStores.media) => unknown) => selector(componentStores.media),
    {
      getState: () => componentStores.media,
      setState: (state: Partial<typeof componentStores.media>) =>
        Object.assign(componentStores.media, state),
    },
  );
  return { useMediaGenerationStore };
});

vi.mock('@/lib/store/settings', () => {
  const useSettingsStore = Object.assign(
    (selector: (state: typeof componentStores.settings) => unknown) =>
      selector(componentStores.settings),
    {
      getState: () => componentStores.settings,
      setState: (state: Partial<typeof componentStores.settings>) =>
        Object.assign(componentStores.settings, state),
    },
  );
  return { useSettingsStore };
});

const SceneProviderWithOptionalChildren = SceneProvider as ComponentType<
  Omit<ComponentProps<typeof SceneProvider>, 'children'> & { children?: ReactNode }
>;

type Presentation = 'concrete' | 'empty' | 'skeleton' | 'disabled';

interface ResolutionCase {
  readonly name: string;
  readonly ref: string;
  readonly task?: MediaTaskState;
  readonly lease?: AssetUrlLeaseState;
  readonly disabled?: boolean;
  readonly expected: Presentation;
  readonly retryable?: boolean;
}

const task = (
  status: MediaTaskState['status'],
  overrides: Omit<Partial<MediaTaskState>, 'status'> = {},
): MediaTaskState => ({ status, retryCount: 0, ...overrides });

const cases: readonly ResolutionCase[] = [
  {
    name: 'resolved allocation',
    ref: 'ast_pool_ref',
    lease: { status: 'resolved', url: 'blob:pool' },
    expected: 'concrete',
  },
  {
    name: 'direct address',
    ref: 'https://example.test/media.png',
    expected: 'concrete',
  },
  {
    name: 'pending generation',
    ref: 'gen_img_pending',
    task: task('pending'),
    expected: 'skeleton',
  },
  {
    name: 'untracked placeholder',
    ref: 'gen_img_placeholder',
    expected: 'skeleton',
  },
  {
    name: 'retryable failure without bytes',
    ref: 'gen_img_retryable',
    task: task('failed', { errorCode: 'UPSTREAM_TIMEOUT' }),
    expected: 'empty',
    retryable: true,
  },
  {
    name: 'retryable failure with last-good bytes',
    ref: 'ast_last_good',
    task: task('failed', { errorCode: 'UPSTREAM_TIMEOUT', objectUrl: 'blob:last-good' }),
    expected: 'concrete',
    retryable: true,
  },
  {
    name: 'generation disabled',
    ref: 'gen_img_disabled',
    task: task('pending'),
    disabled: true,
    expected: 'disabled',
  },
  {
    name: 'missing opaque allocation',
    ref: 'ast_missing_ref',
    expected: 'skeleton',
  },
];

function presentation(src: string, resolution: MediaResolution): Presentation {
  if (src) return 'concrete';
  if (resolution.kind === 'disabled') return 'disabled';
  if (resolution.kind === 'pending' || resolution.kind === 'placeholder') return 'skeleton';
  return 'empty';
}

function expectSafeBinding(
  src: string,
  resolution: MediaResolution,
  expected: Presentation,
  retryable = false,
): void {
  expect(presentation(src, resolution)).toBe(expected);
  expect(src === '' || isConcreteMediaAddress(src)).toBe(true);
  expect(mediaResolutionCanRetry(resolution)).toBe(retryable);
}

function fullTask(ref: string, state: MediaTaskState | undefined, type: 'image' | 'video') {
  if (!state) return undefined;
  return {
    elementId: ref,
    type,
    status: state.status,
    prompt: '',
    params: {},
    objectUrl: state.objectUrl,
    errorCode: state.errorCode,
    retryCount: state.retryCount,
    stageId,
  } satisfies MediaTask;
}

function imageElement(ref: string): PPTImageElement {
  return {
    id: 'image-1',
    type: 'image',
    src: ref,
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    rotate: 0,
    fixedRatio: true,
  };
}

function videoElement(ref: string): PPTVideoElement {
  return {
    id: 'video-1',
    type: 'video',
    src: ref,
    mediaRef: ref,
    left: 0,
    top: 0,
    width: 100,
    height: 56,
    rotate: 0,
    autoplay: false,
    poster: posterRef,
  };
}

function slideWith(element: PPTImageElement | PPTVideoElement): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#fff' },
    elements: [element],
  } as Slide;
}

function stageStoreWith(element: PPTVideoElement): StageStore {
  return {
    getState: () => ({
      stage: { id: stageId },
      currentSceneId: 'scene-1',
      mode: 'edit',
      scenes: [
        {
          id: 'scene-1',
          type: 'slide',
          order: 0,
          title: 'Slide',
          content: { type: 'slide', canvas: slideWith(element) },
          actions: [],
        },
      ],
    }),
    setState: () => undefined,
    subscribe: () => () => undefined,
  } as unknown as StageStore;
}

function renderInMediaScene(
  element: PPTImageElement | PPTVideoElement,
  child: ReturnType<typeof createElement>,
): string {
  const sceneData = { type: 'slide' as const, canvas: slideWith(element) };
  return renderToStaticMarkup(
    createElement(
      MediaStageProvider,
      { value: stageId },
      createElement(
        SceneProviderWithOptionalChildren,
        {
          controller: {
            sceneId: 'scene-1',
            sceneType: 'slide',
            getSnapshot: () => sceneData,
            updateSceneData: () => undefined,
          },
        },
        child,
      ),
    ),
  );
}

/**
 * Vitest runs this project in plain Node, so this matrix cannot assert DOM media
 * attributes or browser playback. It executes each distinct production binding
 * seam once: the shared image resolver, the direct video components' media-ref
 * glue plus the useResolvedMediaRef state machine and renderable URL boundary,
 * and the resolved-slide path shared by thumbnail and renderer consumers.
 * Focused component tests remain responsible for renderer DOM structure.
 */
const componentSurfaces: readonly {
  readonly name: string;
  readonly resolvesPoster?: boolean;
  readonly run: (entry: ResolutionCase) => {
    readonly src: string;
    readonly resolution: MediaResolution;
    readonly poster?: string;
  };
}[] = [
  {
    name: 'shared image-element binding (base and editor)',
    run: (entry: ResolutionCase) => {
      const binding = resolveImageSrc(
        imageElement(entry.ref),
        stageId,
        fullTask(entry.ref, entry.task, 'image'),
        entry.lease?.status === 'resolved' ? entry.lease.url : undefined,
        entry.disabled,
      );
      return { src: binding.resolvedSrc, resolution: binding.resolution };
    },
  },
  {
    name: 'direct video-element binding (base and editor)',
    resolvesPoster: true,
    run: (entry: ResolutionCase) => {
      const element = videoElement(entry.ref);
      hookLeases.current = {
        [entry.ref]: entry.lease ?? MISSING_ASSET_LEASE,
        [posterRef]: posterLease,
      };
      function DirectVideoBindingProbe() {
        const binding = useResolvedVideoMedia(
          element,
          entry.task ? { [entry.ref]: fullTask(entry.ref, entry.task, 'video')! } : {},
          stageId,
          entry.disabled ?? false,
        );
        const payload = Buffer.from(
          JSON.stringify({
            src: binding.resolvedSrc ?? '',
            resolution: binding.resolution,
            poster: binding.resolvedPoster,
          } satisfies {
            src: string;
            resolution: MediaResolution;
            poster?: string;
          }),
        ).toString('base64url');
        return createElement('div', { 'data-binding': payload });
      }
      const markup = renderToStaticMarkup(createElement(DirectVideoBindingProbe));
      const encoded = /data-binding="([^"]+)"/.exec(markup)?.[1];
      if (!encoded) throw new Error('Direct video binding did not render');
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
        src: string;
        resolution: MediaResolution;
        poster?: string;
      };
    },
  },
  {
    name: 'resolved-slide video binding (thumbnail and renderer)',
    resolvesPoster: true,
    run: (entry: ResolutionCase) => {
      const element = videoElement(entry.ref);
      const mediaTask = fullTask(entry.ref, entry.task, 'video');
      const binding = resolveSlideMediaState(
        slideWith(element),
        stageId,
        mediaTask ? { [entry.ref]: mediaTask } : {},
        {
          assetLeases: {
            [entry.ref]: entry.lease ?? MISSING_ASSET_LEASE,
            [posterRef]: posterLease,
          },
          videoGenerationDisabled: entry.disabled,
        },
      );
      return {
        src: (binding.slide.elements[0] as PPTVideoElement).src ?? '',
        resolution: binding.byElementId['video-1'].resolution,
        poster: (binding.slide.elements[0] as PPTVideoElement).poster,
      };
    },
  },
  {
    name: 'action play_video binding',
    run: (entry: ResolutionCase) => {
      const element = videoElement(entry.ref);
      const mediaTask = fullTask(entry.ref, entry.task, 'video');
      const binding = resolveActionVideoMedia(
        stageStoreWith(element),
        mediaTask ? { [entry.ref]: mediaTask } : {},
        element.id,
      );
      if (!binding) throw new Error('Action video binding did not resolve');
      const resolution = resolveMediaRef(
        binding.sourceRef,
        binding.task,
        entry.lease ?? MISSING_ASSET_LEASE,
        entry.disabled,
      );
      return { src: renderableMediaUrl(resolution) ?? '', resolution };
    },
  },
];

describe('real media consumer matrix', () => {
  afterEach(() => {
    useMediaGenerationStore.setState({ tasks: {} });
    useSettingsStore.setState({ imageGenerationEnabled: false, videoGenerationEnabled: false });
    vi.unstubAllGlobals();
  });

  it('prefers a playable concrete src over an untracked opaque mediaRef', () => {
    const reviewerRepro = { src: 'https://cdn.example/direct.mp4', mediaRef: 'ast_opaque' };
    const element = { ...videoElement(reviewerRepro.src), ...reviewerRepro };

    function DirectVideoBindingProbe() {
      const binding = useResolvedVideoMedia(element, {}, stageId, false);
      return createElement('div', {
        'data-resolution': binding.resolution.kind,
        'data-src': binding.resolvedSrc,
      });
    }

    const markup = renderToStaticMarkup(createElement(DirectVideoBindingProbe));
    expect(markup).toContain('data-resolution="raw"');
    expect(markup).toContain('data-src="https://cdn.example/direct.mp4"');
    expect(markup).not.toContain('placeholder');
  });

  it('useResolvedImageSrc prefers element-keyed fork progress over the shared source task', () => {
    const ref = 'ast_shared_image';
    const element = imageElement(ref);
    const source = fullTask(ref, task('done', { objectUrl: 'blob:shared-image' }), 'image');
    const targeted = fullTask(ref, task('pending'), 'image');
    if (!source || !targeted) throw new Error('Expected media tasks');
    useSettingsStore.setState({ imageGenerationEnabled: true });
    useMediaGenerationStore.setState({
      tasks: {
        [ref]: source,
        [element.id]: { ...targeted, elementId: element.id },
      },
    });

    function ImageBindingProbe() {
      const binding = useResolvedImageSrc(element);
      return createElement('div', {
        'data-resolution': binding.resolution.kind,
        'data-src': binding.resolvedSrc,
      });
    }

    const markup = renderToStaticMarkup(
      createElement(MediaStageProvider, { value: stageId }, createElement(ImageBindingProbe)),
    );
    expect(markup).toContain('data-resolution="pending"');
    expect(markup).not.toContain('blob:shared-image');
  });

  it('BaseVideoElement prefers element-keyed fork progress over the shared source task', () => {
    const ref = 'ast_shared_base_video';
    const element = videoElement(ref);
    const source = fullTask(ref, task('done', { objectUrl: 'blob:shared-base-video' }), 'video');
    const targeted = fullTask(ref, task('pending'), 'video');
    if (!source || !targeted) throw new Error('Expected media tasks');
    useSettingsStore.setState({ videoGenerationEnabled: true });
    useMediaGenerationStore.setState({
      tasks: {
        [ref]: source,
        [element.id]: { ...targeted, elementId: element.id },
      },
    });

    const markup = renderInMediaScene(
      element,
      createElement(BaseVideoElement, { elementInfo: element }),
    );
    expect(markup).toContain('vid-pulse-ring');
    expect(markup).not.toContain('blob:shared-base-video');
  });

  it('VideoElement prefers element-keyed fork progress over the shared source task', () => {
    const ref = 'ast_shared_editor_video';
    const element = videoElement(ref);
    const source = fullTask(ref, task('done', { objectUrl: 'blob:shared-editor-video' }), 'video');
    const targeted = fullTask(ref, task('pending'), 'video');
    if (!source || !targeted) throw new Error('Expected media tasks');
    useSettingsStore.setState({ videoGenerationEnabled: true });
    useMediaGenerationStore.setState({
      tasks: {
        [ref]: source,
        [element.id]: { ...targeted, elementId: element.id },
      },
    });

    const markup = renderInMediaScene(
      element,
      createElement(VideoElement, { elementInfo: element }),
    );
    expect(markup).toContain('animate-pulse');
    expect(markup).not.toContain('blob:shared-editor-video');
  });

  it('recovered legacy video tasks bind identically in playback and edit mode', () => {
    const element = videoElement('gen_vid_1');
    const recovered = fullTask(
      'gen_vid_unique_legacy',
      task('done', { objectUrl: 'blob:recovered-video' }),
      'video',
    );
    if (!recovered) throw new Error('Expected recovered video task');
    useSettingsStore.setState({ videoGenerationEnabled: true });
    useMediaGenerationStore.setState({
      tasks: {
        gen_vid_unique_legacy: { ...recovered, placeholderRef: 'gen_vid_1' },
      },
    });

    const playback = renderInMediaScene(
      element,
      createElement(BaseVideoElement, { elementInfo: element }),
    );
    const editor = renderInMediaScene(
      element,
      createElement(VideoElement, { elementInfo: element }),
    );

    expect(playback).toContain('src="blob:recovered-video"');
    expect(editor).toContain('src="blob:recovered-video"');
    expect(playback).not.toContain('vid-pulse-ring');
    expect(editor).not.toContain('animate-pulse');
  });

  for (const surface of componentSurfaces) {
    it.each(cases)(`${surface.name}: $name`, (entry) => {
      const binding = surface.run(entry);
      expectSafeBinding(binding.src, binding.resolution, entry.expected, entry.retryable);
      if (surface.resolvesPoster) expect(binding.poster).toBe('blob:poster');
    });
  }

  it.each(cases)('stage-storage hydration: $name', async (entry) => {
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:hydrated',
      revokeObjectURL: () => undefined,
    });
    const storedBlob =
      entry.lease?.status === 'resolved' ? new Blob(['media'], { type: 'image/png' }) : undefined;
    const src =
      (await resolveThumbnailMediaValue(
        entry.ref,
        entry.task,
        storedBlob,
        'image/png',
        entry.disabled,
      )) ?? '';
    const resolution = resolvePptxMediaBinding(
      entry.ref,
      entry.task,
      storedBlob ? { status: 'resolved', url: src } : MISSING_ASSET_LEASE,
      entry.disabled,
    ).resolution;
    expectSafeBinding(src, resolution, entry.expected, entry.retryable);
  });

  it.each(cases)('PPTX exporter binding: $name', (entry) => {
    const binding = resolvePptxMediaBinding(entry.ref, entry.task, entry.lease, entry.disabled);
    expectSafeBinding(binding.src, binding.resolution, entry.expected, entry.retryable);
  });

  it.each(cases)('video exporter binding: $name', (entry) => {
    const binding = resolveVideoExportMediaBinding(
      entry.ref,
      entry.task,
      entry.lease,
      entry.disabled,
    );
    expectSafeBinding(binding.src, binding.resolution, entry.expected, entry.retryable);
  });
});
