/**
 * The media lane's pure parts: which media an outline asks for and in what
 * order, how a failure is remembered (the code and message the browser's
 * route answers with), the states a snapshot reports, the retry command, and
 * the production wiring of the image and video steps.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateImageStep: vi.fn(),
  generateVideoStep: vi.fn(),
}));

vi.mock('@/lib/server/generation/steps/image', () => ({
  generateImageStep: mocks.generateImageStep,
}));
vi.mock('@/lib/server/generation/steps/video', () => ({
  generateVideoStep: mocks.generateVideoStep,
}));

import { StepRefusal } from '@/lib/server/generation/steps/context';
import { parseRetry } from '@/lib/server/generation/run/input';
import { mediaFailure, runMediaStates } from '@/lib/server/generation/run/media';
import { mediaItemsOf } from '@/lib/server/generation/run/plan';
import { defaultRunStepServices } from '@/lib/server/generation/run/services';
import type { MediaConnection } from '@/lib/server/model-config/media';
import type { SceneOutline } from '@/lib/types/generation';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const connection = { providerId: 'seedream', origin: 'configuration' } as MediaConnection;

describe('the media lane', () => {
  it('takes the media in outline order, each placeholder once', () => {
    const outlines = [
      {
        id: 'o1',
        mediaGenerations: [
          { type: 'video', prompt: 'v', elementId: 'gen_vid_1' },
          { type: 'image', prompt: 'i', elementId: 'gen_img_1' },
        ],
      },
      { id: 'o2' },
      { id: 'o3', mediaGenerations: [{ type: 'image', prompt: 'again', elementId: 'gen_img_1' }] },
      { id: 'o4', mediaGenerations: [{ type: 'image', prompt: 'j', elementId: 'gen_img_2' }] },
    ] as SceneOutline[];
    expect(mediaItemsOf(outlines).map((item) => [item.request.elementId, item.sceneIndex])).toEqual(
      [
        ['gen_vid_1', 0],
        ['gen_img_1', 0],
        ['gen_img_2', 3],
      ],
    );
  });

  it("remembers a failure by the route's code and fixed message, not the provider's text", () => {
    expect(mediaFailure(new Error('HTTP 500 {"secret":"detail"}'), 'image')).toEqual({
      message: 'Image generation failed',
    });
    expect(mediaFailure(new Error('OutputImageSensitiveContentDetected'), 'image')).toEqual({
      message: 'The image provider rejected this prompt under its content safety policy',
      errorCode: 'CONTENT_SENSITIVE',
    });
    expect(mediaFailure(new StepRefusal('missing-api-key', 'No API key'), 'video')).toEqual({
      message: 'No API key',
      errorCode: 'MISSING_API_KEY',
    });
    expect(
      mediaFailure(new StepRefusal('task-connection-changed', 'Slot changed'), 'video'),
    ).toEqual({ message: 'Slot changed', errorCode: 'TASK_CONNECTION_CHANGED' });
    const timeout = Object.assign(new Error('media:gen_vid_1 did not finish within 300 s'), {
      name: 'StepTimeoutError',
    });
    expect(mediaFailure(timeout, 'video')).toEqual({ message: timeout.message });
  });

  it('reports the states a client renders, with the Retry rule of the browser', () => {
    expect(
      runMediaStates(
        new Map([
          ['a', { mediaType: 'image', status: 'queued' }],
          ['b', { mediaType: 'video', status: 'submitted', task: {} as never }],
          ['c', { mediaType: 'image', status: 'stored', assetId: 'ast_c' }],
          ['d', { mediaType: 'video', status: 'done', assetId: 'ast_d', posterAssetId: 'ast_p' }],
          [
            'e',
            { mediaType: 'image', status: 'failed', message: 'x', errorCode: 'CONTENT_SENSITIVE' },
          ],
          ['f', { mediaType: 'image', status: 'failed', message: 'y' }],
        ]),
      ),
    ).toEqual({
      a: { mediaType: 'image', status: 'pending' },
      b: { mediaType: 'video', status: 'generating' },
      c: { mediaType: 'image', status: 'done', assetId: 'ast_c' },
      d: { mediaType: 'video', status: 'done', assetId: 'ast_d', posterAssetId: 'ast_p' },
      e: {
        mediaType: 'image',
        status: 'failed',
        message: 'x',
        errorCode: 'CONTENT_SENSITIVE',
        retryable: false,
      },
      f: { mediaType: 'image', status: 'failed', message: 'y', retryable: true },
    });
  });

  it('parses a retry with or without a media element', () => {
    expect(parseRetry({ commandId: 'c1' })).toEqual({ ok: true, value: { commandId: 'c1' } });
    expect(parseRetry({ commandId: 'c1', media: { elementId: 'gen_img_1' } })).toEqual({
      ok: true,
      value: { commandId: 'c1', media: { elementId: 'gen_img_1' } },
    });
    for (const media of [
      null,
      {},
      { elementId: '' },
      { elementId: 'x'.repeat(129) },
      'gen_img_1',
    ]) {
      expect(parseRetry({ commandId: 'c1', media })).toMatchObject({ ok: false });
    }
    expect(parseRetry({ media: { elementId: 'gen_img_1' } })).toMatchObject({ ok: false });
  });
});

describe('media step services', () => {
  beforeEach(() => {
    mocks.generateImageStep.mockReset();
    mocks.generateVideoStep.mockReset();
  });

  it('asks the image step what the browser asks the image route, and takes inline bytes', async () => {
    mocks.generateImageStep.mockResolvedValue({
      base64: Buffer.from([1, 2, 3]).toString('base64'),
      mimeType: 'image/webp',
      width: 1,
      height: 1,
    });
    const result = await defaultRunStepServices.generateImage(
      'user:a',
      {
        request: {
          type: 'image',
          prompt: 'A leaf',
          elementId: 'gen_img_1',
          aspectRatio: '4:3',
          style: 'watercolor',
        },
        stageId: 'stage-1',
        connection,
      },
      { log },
    );
    expect(mocks.generateImageStep).toHaveBeenCalledWith(
      {
        options: { prompt: 'A leaf', aspectRatio: '4:3', style: 'watercolor', stageId: 'stage-1' },
        connection,
      },
      { log },
    );
    expect(result).toEqual({ bytes: Buffer.from([1, 2, 3]), mimeType: 'image/webp' });
  });

  it('hands the video step the task to resume and the submission callback', async () => {
    mocks.generateVideoStep.mockResolvedValue({
      url: `data:video/mp4;base64,${Buffer.from([9, 9]).toString('base64')}`,
      width: 1,
      height: 1,
      duration: 5,
    });
    const onProviderTask = vi.fn();
    const resume = { taskId: 't', providerId: 'seedance', model: 'm', endpoint: 'https://e' };
    const result = await defaultRunStepServices.generateVideo(
      'user:a',
      {
        request: { type: 'video', prompt: 'Sun', elementId: 'gen_vid_1', aspectRatio: '16:9' },
        connection,
        resume,
        onProviderTask,
      },
      { log },
    );
    expect(mocks.generateVideoStep).toHaveBeenCalledWith(
      {
        options: { prompt: 'Sun', aspectRatio: '16:9' },
        connection,
        onProviderTask,
        resume,
      },
      { log },
    );
    expect(result).toEqual({ video: { bytes: Buffer.from([9, 9]), mimeType: 'video/mp4' } });
  });
});
