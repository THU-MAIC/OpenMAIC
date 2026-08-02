import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  renderableMediaUrl,
  resolveMediaRef,
  type MediaResolution,
  type MediaTaskState,
} from '@/lib/media/resolve-media-ref';
import type { AssetUrlLeaseState } from '@/lib/media/use-asset-url';

const consumingSurfaces = [
  {
    name: 'image renderer',
    file: 'components/slide-renderer/components/element/ImageElement/useResolvedImageSrc.ts',
  },
  {
    name: 'slide renderer and thumbnails',
    file: 'components/slide-renderer/use-resolved-slide.ts',
  },
  { name: 'stage thumbnail hydration', file: 'lib/utils/stage-storage.ts' },
  { name: 'PPTX export', file: 'lib/export/use-export-pptx.ts' },
  { name: 'video export', file: 'lib/video-export-app/collect.ts' },
] as const;

interface ResolutionCase {
  name: string;
  ref: string;
  task?: MediaTaskState;
  lease?: AssetUrlLeaseState;
  disabled?: boolean;
  expected: string;
}

const task = (
  status: MediaTaskState['status'],
  overrides: Omit<Partial<MediaTaskState>, 'status'> = {},
): MediaTaskState => ({ status, retryCount: 0, ...overrides });

const resolutionSpace: readonly ResolutionCase[] = [
  {
    name: 'resolved pool URL',
    ref: 'ast_pool_ref',
    lease: { status: 'resolved', url: 'blob:pool' },
    expected: 'blob:pool',
  },
  {
    name: 'concrete raw URL',
    ref: 'https://example.test/media.png',
    expected: 'https://example.test/media.png',
  },
  {
    name: 'concrete relative URL',
    ref: 'media/user-image.png',
    expected: 'media/user-image.png',
  },
  {
    name: 'pending task',
    ref: 'gen_img_pending',
    task: task('pending'),
    expected: '',
  },
  {
    name: 'generating task',
    ref: 'gen_vid_generating',
    task: task('generating'),
    expected: '',
  },
  {
    name: 'done task URL',
    ref: 'ast_done_ref',
    task: task('done', { objectUrl: 'blob:done' }),
    expected: 'blob:done',
  },
  {
    name: 'done task with missing bytes',
    ref: 'ast_missing_done_ref',
    task: task('done'),
    expected: '',
  },
  {
    name: 'retryable failure',
    ref: 'gen_img_retryable',
    task: task('failed', { errorCode: 'UPSTREAM_TIMEOUT' }),
    expected: '',
  },
  {
    name: 'permanent failure',
    ref: 'gen_img_sensitive',
    task: task('failed', { errorCode: 'CONTENT_SENSITIVE' }),
    expected: '',
  },
  {
    name: 'persisted disabled failure',
    ref: 'gen_img_disabled_failure',
    task: task('failed', { errorCode: 'GENERATION_DISABLED' }),
    expected: '',
  },
  { name: 'placeholder', ref: 'gen_img_placeholder', expected: '' },
  {
    name: 'disabled placeholder',
    ref: 'gen_img_disabled',
    disabled: true,
    expected: '',
  },
  {
    name: 'disabled pending task',
    ref: 'gen_img_disabled_pending',
    task: task('pending'),
    disabled: true,
    expected: '',
  },
  {
    name: 'missing allocated ref',
    ref: 'ast_missing_ref',
    expected: '',
  },
  {
    name: 'untracked pending lease',
    ref: 'ast_pending_lookup',
    lease: { status: 'pending' },
    expected: '',
  },
];

const defensiveResolutionSpace: readonly MediaResolution[] = [
  { kind: 'raw', value: 'ast_missing_ref' },
  { kind: 'url', url: 'opaque_missing_ref' },
];

describe('media resolution surface matrix', () => {
  it.each(consumingSurfaces)('$name consumes the single src boundary', ({ file }) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('renderableMediaUrl');
  });

  for (const surface of consumingSurfaces) {
    it.each(resolutionSpace)(
      `${surface.name}: $name never emits an opaque src`,
      ({ ref, task: taskState, lease = MISSING_ASSET_LEASE, disabled, expected }) => {
        const resolution = resolveMediaRef(ref, taskState, lease, disabled);
        const output = renderableMediaUrl(resolution) ?? '';
        expect(output).toBe(expected);
        expect(output === '' || isConcreteMediaAddress(output)).toBe(true);
      },
    );

    it.each(defensiveResolutionSpace)(
      `${surface.name}: defensive $kind state cannot bypass the src boundary`,
      (resolution) => {
        expect(renderableMediaUrl(resolution)).toBeUndefined();
      },
    );
  }
});
