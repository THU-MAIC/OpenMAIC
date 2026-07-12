import { describe, expect, it } from 'vitest';

import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';

describe('Seed media provider catalog', () => {
  it('includes the official Seedream 5.0 Lite model aliases', () => {
    const modelIds = IMAGE_PROVIDERS.seedream.models.map((model) => model.id);

    expect(modelIds).toEqual(
      expect.arrayContaining(['doubao-seedream-5-0-260128', 'doubao-seedream-5-0-lite-260128']),
    );
  });

  it('includes official Seedance 2.0 video generation models', () => {
    const modelIds = VIDEO_PROVIDERS.seedance.models.map((model) => model.id);

    expect(modelIds).toEqual(
      expect.arrayContaining([
        'doubao-seedance-2-0-260128',
        'doubao-seedance-2-0-fast-260128',
        'doubao-seedance-2-0-mini-260615',
      ]),
    );
  });
});
