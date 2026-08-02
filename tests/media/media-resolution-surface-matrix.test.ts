import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PPTImageElement, PPTVideoElement, Slide } from '@openmaic/dsl';
import { resolveImageSrc } from '@/components/slide-renderer/components/element/ImageElement/useResolvedImageSrc';
import { resolveSlideMediaState } from '@/components/slide-renderer/use-resolved-slide';
import { resolvePptxMediaBinding } from '@/lib/export/use-export-pptx';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  mediaResolutionCanRetry,
  type MediaResolution,
  type MediaTaskState,
} from '@/lib/media/resolve-media-ref';
import type { AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import type { MediaTask } from '@/lib/store/media-generation';
import { resolveThumbnailMediaValue } from '@/lib/utils/stage-storage';
import { resolveVideoExportMediaBinding } from '@/lib/video-export-app/collect';

const stageId = 'stage-matrix';

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

/**
 * Vitest runs this project in plain Node, so mounting the six React consumers
 * would not exercise browser src binding. Each named entry therefore executes
 * the pure seam its component feeds directly into src. Renderer DOM structure
 * remains covered by the focused component tests.
 */
const componentSurfaces = [
  {
    name: 'BaseImageElement',
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
    name: 'ImageElement editor variant',
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
  ...['BaseVideoElement', 'VideoElement index', 'SlideThumbnail', 'RendererScreenCanvas'].map(
    (name) => ({
      name,
      run: (entry: ResolutionCase) => {
        const element = videoElement(entry.ref);
        const mediaTask = fullTask(entry.ref, entry.task, 'video');
        const binding = resolveSlideMediaState(
          slideWith(element),
          stageId,
          mediaTask ? { [entry.ref]: mediaTask } : {},
          {
            assetLeases: { [entry.ref]: entry.lease ?? MISSING_ASSET_LEASE },
            videoGenerationDisabled: entry.disabled,
          },
        );
        return {
          src: (binding.slide.elements[0] as PPTVideoElement).src ?? '',
          resolution: binding.byElementId['video-1'].resolution,
        };
      },
    }),
  ),
] as const;

describe('real media consumer matrix', () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const surface of componentSurfaces) {
    it.each(cases)(`${surface.name}: $name`, (entry) => {
      const binding = surface.run(entry);
      expectSafeBinding(binding.src, binding.resolution, entry.expected, entry.retryable);
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
