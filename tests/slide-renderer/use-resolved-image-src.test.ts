import { describe, it, expect } from 'vitest';
import type { PPTImageElement } from '@/lib/types/slides';
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

  it('falls back to the raw placeholder src when no task is supplied', () => {
    const r = resolveImageSrc(PLACEHOLDER, STAGE, undefined);
    expect(r.resolvedSrc).toBe(PLACEHOLDER.src);
    expect(r.isPlaceholder).toBe(true);
    expect(r.task).toBeUndefined();
  });

  it.each(['pending', 'generating', 'failed'] as const)(
    'falls back when task status is %s',
    (status) => {
      const r = resolveImageSrc(PLACEHOLDER, STAGE, task({ status, objectUrl: undefined }));
      expect(r.resolvedSrc).toBe(PLACEHOLDER.src);
      expect(r.task?.status).toBe(status);
    },
  );

  it('falls back when a done task has no objectUrl set', () => {
    const r = resolveImageSrc(PLACEHOLDER, STAGE, task({ status: 'done', objectUrl: undefined }));
    expect(r.resolvedSrc).toBe(PLACEHOLDER.src);
  });

  it('cross-stage isolation: drops a done task that belongs to a different stage', () => {
    const r = resolveImageSrc(
      PLACEHOLDER,
      STAGE,
      task({ status: 'done', objectUrl: 'blob:other-stage', stageId: 'stage-other' }),
    );
    expect(r.resolvedSrc).toBe(PLACEHOLDER.src);
    expect(r.task).toBeUndefined();
  });

  it('does not consider anything a placeholder when there is no stageId', () => {
    // Even if a "done" task is supplied, no stageId → skip placeholder logic entirely.
    const r = resolveImageSrc(
      PLACEHOLDER,
      undefined,
      task({ status: 'done', objectUrl: 'blob:leak' }),
    );
    expect(r.resolvedSrc).toBe(PLACEHOLDER.src);
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
});
