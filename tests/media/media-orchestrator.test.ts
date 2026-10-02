import { describe, expect, it } from 'vitest';

import { mediaRetryTarget } from '@/lib/media/media-orchestrator';

// Generation, storage, failure records and retries are covered against the
// asset pool and the document in server-backed-media-orchestrator.test.ts.
describe('media orchestrator retry targeting', () => {
  it('retains renderer retry targeting as a read-side compatibility seam', () => {
    expect(mediaRetryTarget('image-element', 'scene-1', { canvas: { id: 'slide-1' } })).toEqual({
      elementId: 'image-element',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });
  });
});
