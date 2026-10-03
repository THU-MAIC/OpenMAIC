import { describe, expect, it } from 'vitest';

import {
  OUTSTANDING_MEDIA_ERROR,
  outstandingMediaRetryTasks,
} from '@/lib/classroom/load-classroom';
import type { MediaTask } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const stageId = 'pre-run-course';

function outline(order: number, elementId: string): SceneOutline {
  return {
    id: `outline-${order}`,
    type: 'slide',
    title: `Scene ${order}`,
    description: 'Scene',
    keyPoints: ['media'],
    order,
    mediaGenerations: [
      { type: 'image', prompt: `Prompt ${order}`, elementId, aspectRatio: '16:9' },
    ],
  };
}

function scene(order: number, src: string): Scene {
  return {
    id: `scene-${order}`,
    stageId,
    title: `Scene ${order}`,
    order,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `slide-${order}`,
        elements: [
          {
            type: 'image',
            id: 'image-1',
            left: 0,
            top: 0,
            width: 10,
            height: 10,
            src,
            fixedRatio: false,
          },
        ],
      },
    },
  } as unknown as Scene;
}

function outstanding(
  overrides: Partial<Parameters<typeof outstandingMediaRetryTasks>[0]> = {},
): Record<string, MediaTask> {
  return outstandingMediaRetryTasks({
    stageId,
    stage: null,
    scenes: [scene(1, 'gen_img_1')],
    outlines: [outline(1, 'gen_img_1')],
    serverProduced: false,
    tasks: {},
    ...overrides,
  });
}

describe('outstanding media of a course no run produces', () => {
  it('offers a placeholder its slide still carries as a failed, retryable task', () => {
    expect(outstanding()).toEqual({
      gen_img_1: {
        elementId: 'gen_img_1',
        type: 'image',
        status: 'failed',
        prompt: 'Prompt 1',
        params: { aspectRatio: '16:9', style: undefined },
        error: OUTSTANDING_MEDIA_ERROR,
        retryCount: 0,
        stageId,
      },
    });
  });

  it('keeps a restored refusal or cached bytes, under the placeholder or an allocated id', () => {
    const refusal = { elementId: 'gen_img_1', status: 'failed', errorCode: 'CONTENT_SENSITIVE' };
    expect(outstanding({ tasks: { gen_img_1: refusal as MediaTask } })).toEqual({});
    const cached = { elementId: 'ast_1', placeholderRef: 'gen_img_1', status: 'done' };
    expect(outstanding({ tasks: { ast_1: cached as MediaTask } })).toEqual({});
  });

  it('offers nothing for an allocated slot, a scene not generated, or a server-produced course', () => {
    expect(outstanding({ scenes: [scene(1, 'ast_allocated')] })).toEqual({});
    expect(outstanding({ scenes: [], outlines: [outline(2, 'gen_img_2')] })).toEqual({});
    expect(outstanding({ serverProduced: true })).toEqual({});
  });
});
