import { describe, expect, it } from 'vitest';
import { lookupMediaTask, type MediaTaskLookupEntry } from '@/lib/media/media-task-resolution';

function task(
  elementId: string,
  placeholderRef?: string,
  stageId = 'stage-1',
): MediaTaskLookupEntry & { elementId: string } {
  return {
    elementId,
    placeholderRef,
    stageId,
    type: 'image',
    status: 'done',
  };
}

describe('lookupMediaTask', () => {
  it.each(['__proto__', 'constructor'])(
    'does not accept inherited Object.prototype member %s as a direct task',
    (ref) => {
      expect(lookupMediaTask({}, ref, 'stage-1')).toBeUndefined();
    },
  );

  it('returns an own direct task for a normal ref', () => {
    const direct = task('ast_direct');

    expect(lookupMediaTask({ ast_direct: direct }, 'ast_direct', 'stage-1')).toBe(direct);
  });

  it.each(['__proto__', 'constructor', 'gen_img_1'])(
    'falls back to a re-keyed task whose placeholderRef is %s',
    (ref) => {
      const rekeyed = task('ast_rekeyed', ref);

      expect(lookupMediaTask({ ast_rekeyed: rekeyed }, ref, 'stage-1')).toBe(rekeyed);
    },
  );
});
