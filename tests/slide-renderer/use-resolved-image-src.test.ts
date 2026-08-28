import { describe, it, expect } from 'vitest';
import type { PPTImageElement } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import { resolveImageSrc } from '@/components/slide-renderer/components/element/ImageElement/useResolvedImageSrc';

const STAGE = 'stage-a';

const PLACEHOLDER: PPTImageElement = {
  id: 'el-placeholder',
  type: 'image',
  src: 'gen_img_alpha_001',
  left: 0,
  top: 0,
  width: 100,
  height: 100,
  rotate: 0,
  fixedRatio: false,
};

const CONCRETE: PPTImageElement = {
  ...PLACEHOLDER,
  id: 'el-concrete',
  src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
};

function task(over: Partial<MediaTask>): MediaTask {
  return {
    elementId: PLACEHOLDER.src,
    type: 'image',
    status: 'done',
    prompt: '',
    params: {} as MediaTask['params'],
    retryCount: 0,
    stageId: STAGE,
    ...over,
  };
}

describe('resolveImageSrc (pure)', () => {
  it('returns the objectUrl when the placeholder task is done', () => {
    const r = resolveImageSrc(
      PLACEHOLDER,
      STAGE,
      task({ status: 'done', objectUrl: 'blob:fake-1' }),
    );
    expect(r.resolvedSrc).toBe('blob:fake-1');
    expect(r.isPlaceholder).toBe(true);
    expect(r.task?.status).toBe('done');
  });

  it('never returns a raw generated placeholder when no task is supplied', () => {
    const r = resolveImageSrc(PLACEHOLDER, STAGE, undefined);
    expect(r.resolvedSrc).toBe('');
    expect(r.resolution).toEqual({ kind: 'placeholder' });
    expect(r.isPlaceholder).toBe(true);
    expect(r.task).toBeUndefined();
  });

  it.each(['pending', 'generating'] as const)('keeps task status %s non-renderable', (status) => {
    const r = resolveImageSrc(PLACEHOLDER, STAGE, task({ status, objectUrl: undefined }));
    expect(r.resolvedSrc).toBe('');
    expect(r.resolution).toEqual({ kind: 'pending' });
    expect(r.task?.status).toBe(status);
  });

  it.each(['pending', 'generating'] as const)(
    'keeps a %s task authoritative over stale pool bytes',
    (status) => {
      const r = resolveImageSrc(
        PLACEHOLDER,
        STAGE,
        task({ status, objectUrl: undefined }),
        'blob:pool-image',
      );
      expect(r.resolvedSrc).toBe('');
      expect(r.resolution).toEqual({ kind: 'pending' });
    },
  );

  it('renders last-good pool bytes for a failed regeneration', () => {
    const r = resolveImageSrc(
      PLACEHOLDER,
      STAGE,
      task({ status: 'failed', objectUrl: undefined }),
      'blob:pool-image',
    );
    expect(r.resolvedSrc).toBe('blob:pool-image');
    expect(r.resolution).toEqual({ kind: 'url', url: 'blob:pool-image', retryable: true });
  });

  it('returns failed without bytes so the surface can render error UI', () => {
    const r = resolveImageSrc(PLACEHOLDER, STAGE, task({ status: 'failed', objectUrl: undefined }));
    expect(r.resolvedSrc).toBe('');
    expect(r.resolution).toEqual({ kind: 'failed', retryable: true });
  });

  it('falls back when a done task has no objectUrl set', () => {
    const r = resolveImageSrc(PLACEHOLDER, STAGE, task({ status: 'done', objectUrl: undefined }));
    expect(r.resolvedSrc).toBe('');
    expect(r.resolution).toEqual({ kind: 'pending' });
  });

  it('cross-stage isolation: drops a done task that belongs to a different stage', () => {
    const r = resolveImageSrc(
      PLACEHOLDER,
      STAGE,
      task({ status: 'done', objectUrl: 'blob:other-stage', stageId: 'stage-other' }),
    );
    expect(r.resolvedSrc).toBe('');
    expect(r.resolution).toEqual({ kind: 'placeholder' });
    expect(r.task).toBeUndefined();
  });

  it('does not consider anything a placeholder when there is no stageId', () => {
    // Even if a "done" task is supplied, no stageId → skip placeholder logic entirely.
    const r = resolveImageSrc(
      PLACEHOLDER,
      undefined,
      task({ status: 'done', objectUrl: 'blob:leak' }),
    );
    expect(r.resolvedSrc).toBe('');
    expect(r.resolution).toEqual({ kind: 'placeholder' });
    expect(r.isPlaceholder).toBe(false);
    expect(r.task).toBeUndefined();
  });

  it('passes through non-placeholder src unchanged (additive contract)', () => {
    // Even with a done task supplied — the regex gate rejects non-placeholder src.
    const r = resolveImageSrc(
      CONCRETE,
      STAGE,
      task({ status: 'done', objectUrl: 'blob:should-not-touch' }),
    );
    expect(r.resolvedSrc).toBe(CONCRETE.src);
    expect(r.isPlaceholder).toBe(false);
    expect(r.task).toBeUndefined();
  });

  it('falls back to an unknown browser-resolvable string when pool lookup misses', () => {
    const unknown = { ...PLACEHOLDER, src: 'logo.png' };
    const r = resolveImageSrc(unknown, STAGE, undefined, null);
    expect(r.resolvedSrc).toBe('logo.png');
  });

  it('hides an opaque allocated ref when pool lookup misses', () => {
    const allocated = { ...PLACEHOLDER, src: 'ast_missing_image' };
    const r = resolveImageSrc(allocated, STAGE, undefined, null);
    expect(r.resolvedSrc).toBe('');
    expect(r.resolution).toEqual({ kind: 'placeholder' });
  });

  it('renders an allocated asset id through the pool lease (RFC #1153 part 2)', () => {
    // `resolveImageIds` writes the allocated pool asset id into
    // `PPTImageElement.src` on server-backed deployments; the renderer already
    // resolves opaque refs through the pool registry, so the resolved pool URL
    // is what reaches the <img>.
    const allocated = { ...PLACEHOLDER, src: 'ast_allocated_image_0001' };
    const r = resolveImageSrc(allocated, STAGE, undefined, 'blob:pool-image');
    expect(r.resolvedSrc).toBe('blob:pool-image');
    expect(r.resolvedFromAsset).toBe(true);
    expect(r.resolution).toEqual({ kind: 'url', url: 'blob:pool-image' });
  });

  it('returns disabled for an unresolved placeholder when generation is off', () => {
    const r = resolveImageSrc(PLACEHOLDER, STAGE, undefined, null, true);
    expect(r.resolvedSrc).toBe('');
    expect(r.resolution).toEqual({ kind: 'disabled' });
  });
});
