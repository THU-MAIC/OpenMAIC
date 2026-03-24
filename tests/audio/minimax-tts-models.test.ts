import { describe, expect, it } from 'vitest';

import { MINIMAX_TTS_MODELS } from '@/lib/audio/constants';

describe('MiniMax TTS model list', () => {
  it('includes the official speech-01 models', () => {
    const modelIds = MINIMAX_TTS_MODELS.map((model) => model.id);

    expect(modelIds).toContain('speech-01-turbo');
    expect(modelIds).toContain('speech-01-hd');
  });
});
