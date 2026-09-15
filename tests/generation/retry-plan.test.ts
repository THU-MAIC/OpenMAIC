import { describe, expect, it } from 'vitest';
import {
  isSafeToAutoRetry,
  stepsToRetry,
  retrySessionFields,
  completedCheckpointSteps,
} from '@/lib/generation/retry-plan';

describe('stepsToRetry', () => {
  const active = [
    'pdf-analysis',
    'web-search',
    'outline',
    'agent-generation',
    'slide-content',
    'actions',
    'tts',
  ] as const;
  it('retries the failed step and only its dependent suffix', () => {
    expect(stepsToRetry('web-search', active)).toEqual([
      'web-search',
      'outline',
      'agent-generation',
      'slide-content',
      'actions',
      'tts',
    ]);
    expect(stepsToRetry('actions', active)).toEqual(['actions', 'tts']);
  });
  it('keeps only safe, replayable operations on automatic retry', () => {
    expect(isSafeToAutoRetry('web-search')).toBe(true);
    expect(isSafeToAutoRetry('outline')).toBe(false);
    expect(isSafeToAutoRetry('tts')).toBe(false);
  });
  it('invalidates the failed step and downstream results only', () => {
    expect(retrySessionFields('outline')).toEqual([
      'agent-generation',
      'slide-content',
      'actions',
      'tts',
      'outline',
    ]);
  });
  it('identifies reusable checkpoints without treating TTS as complete', () => {
    expect(
      completedCheckpointSteps({
        pdfText: 'doc',
        researchContext: 'web',
        sceneOutlines: [{}],
        generatedAgents: [{}],
        generatedFirstSceneContent: {},
        generatedFirstScene: {},
      }),
    ).toEqual([
      'pdf-analysis',
      'web-search',
      'outline',
      'agent-generation',
      'slide-content',
      'actions',
    ]);
  });
});
