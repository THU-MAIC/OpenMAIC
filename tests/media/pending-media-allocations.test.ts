/**
 * A parked allocation is scoped to one run of one course.
 *
 * Classic placeholders are reused across runs (`gen_img_1` is `gen_img_1` in
 * every deck), so an entry that survives an interrupted run would be handed to
 * a different slide of the next one — the previous deck's picture, silently, on
 * a slide whose provider was never asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPendingMediaAllocations,
  forgetMediaAllocation,
  pendingMediaAllocation,
  recordPendingMediaAllocation,
  takePendingMediaAllocations,
} from '@/lib/media/pending-media-allocations';

const allocation = {
  stageId: 'stage-1',
  placeholderRef: 'gen_img_1',
  assetId: 'ast_old',
};

describe('pending media allocations', () => {
  beforeEach(() => clearPendingMediaAllocations());

  it('answers only for the course that parked it', () => {
    recordPendingMediaAllocation(allocation);

    expect(pendingMediaAllocation('stage-1', 'gen_img_1')).toMatchObject({ assetId: 'ast_old' });
    expect(pendingMediaAllocation('stage-2', 'gen_img_1')).toBeUndefined();
    expect(pendingMediaAllocation(undefined, 'gen_img_1')).toBeUndefined();
  });

  it('is drained by taking, so one allocation reaches one slide', () => {
    recordPendingMediaAllocation(allocation);

    expect(takePendingMediaAllocations('stage-1', ['gen_img_1'])).toHaveLength(1);
    expect(takePendingMediaAllocations('stage-1', ['gen_img_1'])).toHaveLength(0);
  });

  it('cannot be consumed by a later run once the course is cleared', () => {
    recordPendingMediaAllocation(allocation);
    recordPendingMediaAllocation({ ...allocation, stageId: 'stage-2', assetId: 'ast_other' });

    clearPendingMediaAllocations('stage-1');

    expect(takePendingMediaAllocations('stage-1', ['gen_img_1'])).toEqual([]);
    // Another course's parked work is untouched.
    expect(pendingMediaAllocation('stage-2', 'gen_img_1')).toMatchObject({ assetId: 'ast_other' });
  });

  it('clears every course when no course is named', () => {
    recordPendingMediaAllocation(allocation);
    recordPendingMediaAllocation({ ...allocation, stageId: 'stage-2' });

    clearPendingMediaAllocations();

    expect(pendingMediaAllocation('stage-1', 'gen_img_1')).toBeUndefined();
    expect(pendingMediaAllocation('stage-2', 'gen_img_1')).toBeUndefined();
  });

  it('separates courses whose ids share a prefix', () => {
    recordPendingMediaAllocation(allocation);
    recordPendingMediaAllocation({ ...allocation, stageId: 'stage-10', assetId: 'ast_ten' });

    clearPendingMediaAllocations('stage-1');

    expect(pendingMediaAllocation('stage-10', 'gen_img_1')).toMatchObject({ assetId: 'ast_ten' });
  });
});

/**
 * A parked entry owns its object URLs.
 *
 * When a write-back fails with the allocation retained, the commit path
 * deliberately does not revoke them: the entry becomes the only thing holding
 * bytes this tab can render, and the failed task carries no URL of its own.
 * Dropping the entry without revoking therefore pins the whole blob -- a video
 * and its poster -- for the life of the tab, and repeated failures accumulate.
 */
describe('the object URLs a parked allocation holds', () => {
  const revoke = vi.fn();
  const withUrls = {
    stageId: 'stage-1',
    placeholderRef: 'gen_vid_1',
    assetId: 'ast_video',
    posterAssetId: 'ast_poster',
    objectUrl: 'blob:video',
    posterObjectUrl: 'blob:poster',
  };

  beforeEach(() => {
    clearPendingMediaAllocations();
    revoke.mockReset();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: revoke });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('releases them when the course is cleared', () => {
    recordPendingMediaAllocation(withUrls);

    clearPendingMediaAllocations('stage-1');

    expect(revoke.mock.calls.map(([url]) => url)).toEqual(['blob:video', 'blob:poster']);
  });

  it('releases them when every course is cleared', () => {
    recordPendingMediaAllocation(withUrls);

    clearPendingMediaAllocations();

    expect(revoke.mock.calls.map(([url]) => url)).toEqual(['blob:video', 'blob:poster']);
  });

  it('releases them when the allocation is forgotten', () => {
    recordPendingMediaAllocation(withUrls);

    forgetMediaAllocation('stage-1', 'gen_vid_1');

    expect(revoke.mock.calls.map(([url]) => url)).toEqual(['blob:video', 'blob:poster']);
  });

  // Once the entry is drained the task table is displaying those URLs. Revoking
  // one out from under a slide that is showing it is a worse bug than the leak,
  // and an entry that survives only in the non-draining record is in exactly
  // that state.
  it('leaves them alone once a slide has taken them', () => {
    recordPendingMediaAllocation(withUrls);
    expect(takePendingMediaAllocations('stage-1', ['gen_vid_1'])).toHaveLength(1);

    clearPendingMediaAllocations('stage-1');
    forgetMediaAllocation('stage-1', 'gen_vid_1');

    expect(revoke).not.toHaveBeenCalled();
  });
});
