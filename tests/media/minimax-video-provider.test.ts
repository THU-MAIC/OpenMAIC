import { describe, expect, it } from 'vitest';

import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';

describe('MiniMax video provider', () => {
  it('does not expose Hailuo 2.3 Fast in the current T2V-only model list', () => {
    const modelIds = VIDEO_PROVIDERS['minimax-video'].models.map((model) => model.id);

    expect(modelIds).toContain('MiniMax-Hailuo-2.3');
    expect(modelIds).not.toContain('MiniMax-Hailuo-2.3-Fast');
  });
});
