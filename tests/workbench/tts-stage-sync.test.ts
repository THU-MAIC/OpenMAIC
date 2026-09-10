import { describe, expect, it } from 'vitest';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { WorkbenchEvent } from '@/lib/workbench/session-store';
import { applyGenerateTtsResultToScenes } from '@/lib/workbench/tts-stage-sync';

function scene(id: string, actions: SpeechAction[]): Scene {
  return {
    id,
    stageId: 'stage-1',
    order: 1,
    title: id,
    type: 'slide',
    content: { type: 'slide', canvas: { id: `canvas-${id}`, elements: [] } },
    actions,
  } as unknown as Scene;
}

function toolEnd(overrides: Record<string, unknown> = {}): WorkbenchEvent {
  return {
    id: 10,
    ts: 100,
    attempt: 1,
    type: 'tool_execution_end',
    data: {
      toolName: 'generate_tts',
      result: {
        details: {
          sceneId: 'scene-1',
          sceneActions: [
            {
              id: 'speech-1_tts_1',
              type: 'speech',
              text: 'fresh narration',
              audioId: 'tts_s1_speech-1_tts_1',
              audioUrl: '/api/classroom-media/stage-1/audio/fresh.mp3',
            },
          ],
        },
      },
      ...overrides,
    },
  };
}

describe('generate_tts live stage synchronization', () => {
  it('replaces the matching scene actions with the persisted post-synthesis actions', () => {
    const original = [
      scene('scene-1', [{ id: 'speech-1', type: 'speech', text: 'stale narration' }]),
      scene('scene-2', [{ id: 'speech-2', type: 'speech', text: 'untouched' }]),
    ];

    const next = applyGenerateTtsResultToScenes(original, toolEnd());

    expect(next).not.toBe(original);
    expect(next[0]?.actions).toEqual([
      expect.objectContaining({
        id: 'speech-1_tts_1',
        audioId: 'tts_s1_speech-1_tts_1',
        audioUrl: '/api/classroom-media/stage-1/audio/fresh.mp3',
      }),
    ]);
    expect(next[1]).toBe(original[1]);
  });

  it('ignores failed, unrelated, and malformed completion events', () => {
    const original = [scene('scene-1', [{ id: 'speech-1', type: 'speech', text: 'original' }])];

    expect(applyGenerateTtsResultToScenes(original, toolEnd({ isError: true }))).toBe(original);
    expect(applyGenerateTtsResultToScenes(original, toolEnd({ toolName: 'edit_actions' }))).toBe(
      original,
    );
    expect(
      applyGenerateTtsResultToScenes(
        original,
        toolEnd({ result: { details: { sceneId: 'scene-1' } } }),
      ),
    ).toBe(original);
  });
});
