import { describe, expect, it } from 'vitest';

import { applyRunEvent, viewFromSnapshot } from '@/lib/generation-run-client/reducer';
import { runFailureText, sceneFailureText } from '@/lib/generation-run-client/failure-message';
import { RunApiError, runApiErrorText } from '@/lib/generation-run-client/api';

import { event, snapshot } from './fixtures';

describe('what a paused run says', () => {
  const at = (step: string, extra: Record<string, unknown> = {}) =>
    runFailureText({ step, message: 'raw message', ...extra });

  it.each([
    null,
    'material-analysis',
    'research',
    'outline',
    'scene:0:content',
    'scene:1:actions',
    'scene:2:narration',
  ])('shows the provider quota guidance at %s instead of the provider message', (step) => {
    expect(
      runFailureText({
        step,
        errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
        statusCode: 429,
        message: 'raw provider message',
      }),
    ).toEqual({
      key: 'generation.quotaExhausted',
    });
  });

  it('prefers a classified provider quota failure over its HTTP status in a scene', () => {
    expect(sceneFailureText({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED', statusCode: 403 })).toEqual({
      key: 'generation.quotaExhausted',
    });
  });

  it.each(['outline', 'scene:1:content'])(
    'leaves a host’s own quota code at %s to the host’s message',
    (step) => {
      expect(
        runFailureText({ step, errorCode: 'QUOTA_EXHAUSTED', message: 'Upgrade your plan' }),
      ).toEqual({ text: 'Upgrade your plan' });
    },
  );

  it('keeps the host’s own message when it refuses to start a run', () => {
    const translate = (key: string) => `translated:${key}`;
    expect(
      runApiErrorText(
        new RunApiError(
          402,
          'QUOTA_EXHAUSTED',
          'No credit left: https://host.example/billing',
          'upload.generateFailed',
        ),
        translate,
      ),
    ).toBe('No credit left: https://host.example/billing');
    expect(
      runApiErrorText(
        new RunApiError(429, 'ACTIVE_RUN_LIMIT', 'too many runs', 'upload.generateFailed'),
        translate,
      ),
    ).toBe('translated:generation.activeRunLimit');
  });

  it('says a scene failure the way the classic preview did', () => {
    expect(at('scene:0:content', { errorCode: 'UPSTREAM_ERROR', statusCode: 503 })).toEqual({
      key: 'generation.sceneGenerateProviderUnavailable',
    });
    expect(at('scene:0:actions', { errorCode: 'RATE_LIMITED', statusCode: 429 })).toEqual({
      key: 'generation.sceneGenerateRateLimited',
    });
    expect(at('scene:0:content', { errorCode: 'UPSTREAM_ERROR', statusCode: 401 })).toEqual({
      key: 'generation.sceneGenerateAuthFailed',
    });
    expect(at('scene:0:content', { errorCode: 'MISSING_API_KEY' })).toEqual({
      key: 'generation.sceneGenerateAuthFailed',
    });
    expect(at('scene:2:actions', { errorCode: 'GENERATION_FAILED' })).toEqual({
      key: 'generation.sceneGenerateInvalidResponse',
    });
    expect(at('scene:0:content', { errorCode: 'INTERNAL_ERROR' })).toEqual({
      key: 'generation.sceneGenerateFailed',
    });
    // An unknown code (or none) says the run's own message.
    expect(at('scene:0:content', { errorCode: 'SOMETHING_NEW', statusCode: 400 })).toEqual({
      text: 'raw message',
    });
    expect(at('scene:0:content')).toEqual({ text: 'raw message' });
  });

  it('says the other steps as their own screens did', () => {
    expect(at('scene:0:narration')).toEqual({ key: 'generation.speechFailed' });
    expect(at('material-analysis')).toEqual({ key: 'generation.courseMaterialParseFailed' });
    expect(at('outline')).toEqual({ text: 'raw message' });
    expect(runFailureText({ step: 'outline', message: '' })).toEqual({
      key: 'generation.outlineGenerateFailed',
    });
    expect(runFailureText({ step: 'research', message: '' })).toEqual({
      key: 'generation.webSearchFailed',
    });
  });

  it('keeps the code of the failure the run paused at', () => {
    let view = viewFromSnapshot(snapshot({ state: 'generating', seq: 1 }));
    view = applyRunEvent(
      view,
      event(2, 'step_failed', {
        step: 'scene:0:content',
        message: 'x',
        errorCode: 'UPSTREAM_ERROR',
        statusCode: 502,
      }),
    );
    expect(view.error).toEqual({
      step: 'scene:0:content',
      message: 'x',
      errorCode: 'UPSTREAM_ERROR',
      statusCode: 502,
    });
  });
});
