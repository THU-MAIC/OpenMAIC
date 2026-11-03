import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confirmOutline,
  resetCommandIds,
  retryPausedRun,
  retryRunMedia,
} from '@/lib/generation-run-client/commands';
import { viewFromSnapshot, applyRunEvent } from '@/lib/generation-run-client/reducer';

import { event, outline, snapshot } from './fixtures';

const fetchMock = vi.fn();

beforeEach(() => {
  resetCommandIds();
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ success: true, state: 'generating', seq: 50 }), {
        status: 200,
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function bodies(): Array<{ url: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
  }));
}

const ready = {
  outlines: [outline(1), outline(2)],
  languageDirective: 'en',
  taskEngineMode: false,
  revision: 3,
};

describe('run commands', () => {
  it('confirms an outline with one command id per revision and edit', async () => {
    const view = viewFromSnapshot(
      snapshot({ state: 'awaiting_outline_confirmation', seq: 9, outline: ready }),
    );
    await confirmOutline(view);
    await confirmOutline(view);
    const edit = [outline(1, 'Edited')];
    await confirmOutline(view, edit);
    const [first, second, edited] = bodies();
    expect(first!.url).toBe('/api/generation-runs/run-AAAAAAAAAAAAAAAA/confirm-outline');
    expect(first!.body).toEqual({ commandId: first!.body.commandId, outlineRevision: 3 });
    expect(second!.body.commandId).toBe(first!.body.commandId);
    expect(edited!.body.commandId).not.toBe(first!.body.commandId);
    expect(edited!.body.outlines).toEqual(edit);
  });

  it('retries a pause with one command id per failure, and answers the command seq', async () => {
    let view = viewFromSnapshot(snapshot({ state: 'generating', seq: 10, outline: ready }));
    view = applyRunEvent(view, event(11, 'step_failed', { step: 'scene:0:content', message: 'x' }));
    view = applyRunEvent(view, event(12, 'state', { state: 'paused', step: 'scene:0:content' }));
    expect(await retryPausedRun(view)).toBe(50);
    // A media event during the pause does not make the same Retry a new command.
    view = applyRunEvent(
      view,
      event(13, 'media', { elementId: 'gen_img_1', mediaType: 'image', status: 'done' }),
    );
    await retryPausedRun(view);
    // The next failure is a new Retry.
    view = applyRunEvent(
      view,
      event(14, 'step_failed', { step: 'scene:0:content', message: 'again' }),
    );
    await retryPausedRun(view);
    const [a, b, c] = bodies();
    expect(a!.url).toBe('/api/generation-runs/run-AAAAAAAAAAAAAAAA/retry');
    expect(a!.body).toEqual({ commandId: a!.body.commandId });
    expect(b!.body.commandId).toBe(a!.body.commandId);
    expect(c!.body.commandId).not.toBe(a!.body.commandId);
  });

  it('passes the updated voice in a voice-failure retry so resumed narration uses it', async () => {
    let view = viewFromSnapshot(snapshot({ state: 'generating', seq: 10, outline: ready }));
    // Narration pauses because the bound voice clone is gone.
    view = applyRunEvent(
      view,
      event(11, 'step_failed', {
        step: 'scene:0:narration',
        message: 'The cloned Qwen voice no longer exists.',
      }),
    );
    view = applyRunEvent(view, event(12, 'state', { state: 'paused', step: 'scene:0:narration' }));

    // The user re-clones or selects a new voice, then clicks Retry.
    const updatedVoice = { providerId: 'qwen-tts', voiceId: 'qwen-tts-vc-clone-2', speed: 1.25 };
    await retryPausedRun(view, updatedVoice);
    const [retry] = bodies();
    expect(retry!.url).toBe('/api/generation-runs/run-AAAAAAAAAAAAAAAA/retry');
    expect(retry!.body).toEqual({ commandId: retry!.body.commandId, voice: updatedVoice });

    // A Retry without a voice sends no voice field (backward-compatible).
    await retryPausedRun(view);
    const [, noVoice] = bodies();
    expect('voice' in noVoice!.body).toBe(false);
  });

  it('retries one media element by its failure', async () => {
    let view = viewFromSnapshot(snapshot({ state: 'completed', seq: 10, outline: ready }));
    view = applyRunEvent(
      view,
      event(11, 'media', {
        elementId: 'gen_img_1',
        mediaType: 'image',
        status: 'failed',
        retryable: true,
      }),
    );
    await retryRunMedia(view, 'gen_img_1');
    await retryRunMedia(view, 'gen_img_1');
    view = applyRunEvent(
      view,
      event(12, 'media', { elementId: 'gen_img_1', mediaType: 'image', status: 'pending' }),
    );
    view = applyRunEvent(
      view,
      event(13, 'media', {
        elementId: 'gen_img_1',
        mediaType: 'image',
        status: 'failed',
        retryable: true,
      }),
    );
    await retryRunMedia(view, 'gen_img_1');
    const [a, b, c] = bodies();
    expect(a!.body).toEqual({ commandId: a!.body.commandId, media: { elementId: 'gen_img_1' } });
    expect(b!.body.commandId).toBe(a!.body.commandId);
    expect(c!.body.commandId).not.toBe(a!.body.commandId);
  });

  it('surfaces the route error code', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errorCode: 'RUN_STATE_CONFLICT',
          error: 'The run is generating, not paused',
        }),
        { status: 409 },
      ),
    );
    const view = viewFromSnapshot(
      snapshot({ state: 'paused', seq: 4, error: { step: 'agents', message: 'x' } }),
    );
    await expect(retryPausedRun(view)).rejects.toMatchObject({
      status: 409,
      errorCode: 'RUN_STATE_CONFLICT',
    });
  });
});
