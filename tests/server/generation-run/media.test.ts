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
  resolveMediaSlot: vi.fn(),
  storeGeneratedAsset: vi.fn(),
  commitGenerationRunIn: vi.fn(),
}));

vi.mock('@/lib/server/model-config/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/media')>()),
  resolveMediaSlot: mocks.resolveMediaSlot,
}));
vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/runtime')>()),
  backgroundWorkspaceId: async (ownerId: string) => ownerId,
}));
vi.mock('@/lib/server/store-generated-asset', () => ({
  storeGeneratedAsset: mocks.storeGeneratedAsset,
}));
vi.mock('@/lib/server/generation/run/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/generation/run/store')>()),
  commitGenerationRunIn: mocks.commitGenerationRunIn,
}));

vi.mock('@/lib/server/generation/steps/image', () => ({
  generateImageStep: mocks.generateImageStep,
}));
vi.mock('@/lib/server/generation/steps/video', () => ({
  generateVideoStep: mocks.generateVideoStep,
}));

import { StepRefusal } from '@/lib/server/generation/steps/context';
import { parseRetry } from '@/lib/server/generation/run/input';
import { mediaFailure, runMediaLane, runMediaStates } from '@/lib/server/generation/run/media';
import { GenerationRunLeaseLostError } from '@/lib/server/generation/run/store';
import { InvalidOwnerCredentialError } from '@/lib/server/identity/resolve';
import { SlotDisabledError, SlotUnassignedError } from '@/lib/server/model-config/runtime';
import { WorkspaceEndpointError } from '@/lib/server/model-config/media';
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
          ['g', { mediaType: 'image', status: 'generating' }],
          ['s', { mediaType: 'video', status: 'skipped' }],
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
      // Stored bytes are done once the course names them.
      c: { mediaType: 'image', status: 'generating' },
      g: { mediaType: 'image', status: 'generating' },
      s: { mediaType: 'video', status: 'disabled' },
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

describe('the media slots of a run', () => {
  beforeEach(() => {
    mocks.resolveMediaSlot.mockReset();
  });

  it('answers each kind as the generation routes answer its resolution', async () => {
    const refusals: Record<string, unknown> = {
      off: new SlotDisabledError('image'),
      unassigned: new SlotUnassignedError('image'),
      endpoint: new WorkspaceEndpointError('The endpoint is not allowed'),
      credential: new InvalidOwnerCredentialError(),
    };
    for (const [name, error] of Object.entries(refusals)) {
      mocks.resolveMediaSlot.mockImplementation(async (kind: string) => {
        if (kind === 'image') throw error;
        return connection;
      });
      const slots = await defaultRunStepServices.mediaConnections('user:a');
      expect(slots.video).toEqual({ status: 'ready', connection });
      expect([name, slots.image]).toEqual([
        name,
        {
          off: { status: 'off' },
          unassigned: { status: 'off' },
          endpoint: {
            status: 'refused',
            message: 'The endpoint is not allowed',
            errorCode: 'INVALID_URL',
          },
          credential: {
            status: 'refused',
            message: 'invalid owner credential',
            errorCode: 'INVALID_CREDENTIAL',
          },
        }[name],
      ]);
    }
  });

  it('lets any other failure through: a fault of the pass, not an answer', async () => {
    mocks.resolveMediaSlot.mockImplementation(async () => {
      throw new Error('config unreadable');
    });
    await expect(defaultRunStepServices.mediaConnections('user:a')).rejects.toThrow(
      'config unreadable',
    );
  });
});

describe('recording a submitted video task', () => {
  const TASK = { taskId: 't1', providerId: 'seedance', model: 'm', endpoint: 'https://e' };

  function laneContext(commit: (change: unknown) => Promise<void>) {
    const steps = new Map<string, unknown>([
      ['media:gen_vid_1', { mediaType: 'video', status: 'queued' }],
    ]);
    const services = {
      ...defaultRunStepServices,
      mediaConnections: async () => ({
        image: { status: 'off' as const },
        video: { status: 'ready' as const, connection },
      }),
      generateVideo: vi.fn(
        async (_owner: string, input: { onProviderTask: (task: typeof TASK) => Promise<void> }) => {
          await input.onProviderTask(TASK);
          return { video: { bytes: new Uint8Array([1]), mimeType: 'video/mp4' } };
        },
      ),
      sleep: vi.fn(async () => undefined),
      releaseAssets: vi.fn(async () => undefined),
    };
    return {
      steps,
      services,
      ctx: {
        runId: 'run-x',
        lease: { runId: 'run-x', workerId: 'w', generation: 1 },
        signal: new AbortController().signal,
        services,
        owner: () => 'user:a',
        refreshOwner: async () => undefined,
        stageId: 'stage-1',
        outline: { outlines: [], languageDirective: '', taskEngineMode: false },
        items: [
          {
            request: { type: 'video' as const, prompt: 'p', elementId: 'gen_vid_1' },
            sceneIndex: 0,
          },
        ],
        steps,
        commit: async (change: { step?: { id: string; output: unknown } }) => {
          await commit(change);
          if (change.step) steps.set(change.step.id, change.step.output);
        },
        place: vi.fn(async () => true),
        stopping: () => false,
      },
    };
  }

  beforeEach(() => {
    mocks.storeGeneratedAsset
      .mockReset()
      .mockImplementation(
        async (input: { afterPut?: (tx: unknown, id: string) => Promise<void> }) => {
          await input.afterPut?.({}, 'ast_v');
          return { status: 'stored', assetId: 'ast_v' };
        },
      );
  });

  it('writes the task record again in place when the write fails for a passing reason', async () => {
    let failures = 1;
    const { ctx, services, steps } = laneContext(async (change) => {
      const output = (change as { step?: { output: { status: string } } }).step?.output;
      if (output?.status === 'submitted' && failures-- > 0) throw new Error('connection reset');
    });
    await runMediaLane(ctx as never);
    expect(services.sleep).toHaveBeenCalledTimes(1);
    expect(services.generateVideo).toHaveBeenCalledTimes(1);
    expect(steps.get('media:gen_vid_1')).toEqual({
      mediaType: 'video',
      status: 'stored',
      assetId: 'ast_v',
    });
    expect(ctx.place).toHaveBeenCalledTimes(1);
  });

  it('does not write it again for a lease that is gone', async () => {
    const { ctx, services } = laneContext(async (change) => {
      const output = (change as { step?: { output: { status: string } } }).step?.output;
      if (output?.status === 'submitted') {
        throw new GenerationRunLeaseLostError({ runId: 'run-x', workerId: 'w', generation: 1 });
      }
    });
    await expect(runMediaLane(ctx as never)).rejects.toBeInstanceOf(GenerationRunLeaseLostError);
    expect(services.sleep).not.toHaveBeenCalled();
  });
});
