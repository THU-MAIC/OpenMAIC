/**
 * The event sink is the service's only operational output, so its shape is a
 * contract: one JSON line, bounded dimensions only, and a level that lets a
 * pipeline separate failures from routine transitions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_PREVIEW_IMAGE_MESSAGE,
  classifyPreviewFailure,
  emitRenderEvent,
} from '../src/events.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStdout(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return { lines };
}

describe('emitRenderEvent', () => {
  it('writes one parseable JSON line carrying the event dimensions', () => {
    const { lines } = captureStdout();

    emitRenderEvent({
      event: 'render_job_started',
      jobId: 'job-1',
      queueWaitMs: 1234,
      queued: 2,
      running: 1,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({
      service: 'render-service',
      component: 'render',
      level: 'INFO',
      event: 'render_job_started',
      jobId: 'job-1',
      queueWaitMs: 1234,
    });
    expect(typeof parsed.timestamp).toBe('string');
    expect(parsed.message).toContain('1234ms');
  });

  it('omits absent dimensions rather than serializing nulls', () => {
    const { lines } = captureStdout();

    emitRenderEvent({ event: 'render_job_submitted', jobId: 'job-2' });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed).not.toHaveProperty('queueWaitMs');
    expect(parsed).not.toHaveProperty('outcome');
    expect(parsed).not.toHaveProperty('errorCode');
    expect(lines[0]).not.toContain('null');
  });

  it('reports a failed render at ERROR on stderr so stderr-only pipelines see it', () => {
    const { lines } = captureStdout();
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });

    emitRenderEvent({
      event: 'render_job_finished',
      jobId: 'job-3',
      outcome: 'failed',
      durationMs: 900,
      errorCode: 'execution_failed',
    });

    expect(lines).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({
      level: 'ERROR',
      outcome: 'failed',
      errorCode: 'execution_failed',
    });
  });

  it('keeps a cancelled render at INFO — it is an outcome, not a fault', () => {
    const { lines } = captureStdout();

    emitRenderEvent({ event: 'render_job_finished', jobId: 'job-4', outcome: 'cancelled' });

    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'INFO', outcome: 'cancelled' });
  });

  it('labels the preview route with its own component', () => {
    const { lines } = captureStdout();

    emitRenderEvent({
      event: 'preview_request',
      route: '/preview',
      status: 200,
      durationMs: 800,
    });

    expect(JSON.parse(lines[0]!)).toMatchObject({
      component: 'preview',
      level: 'INFO',
      status: 200,
    });
  });

  it('reports a 5xx preview at ERROR on stderr with its error code', () => {
    const { lines } = captureStdout();
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });

    emitRenderEvent({
      event: 'preview_request',
      route: '/preview',
      status: 500,
      durationMs: 1200,
      errorCode: 'browser_launch_failed',
    });

    expect(lines).toHaveLength(0);
    expect(JSON.parse(errors[0]!)).toMatchObject({
      component: 'preview',
      level: 'ERROR',
      status: 500,
      errorCode: 'browser_launch_failed',
    });
  });

  it('keeps a 4xx preview at INFO: the caller sent something wrong', () => {
    const { lines } = captureStdout();

    emitRenderEvent({ event: 'preview_request', route: '/preview', status: 400, durationMs: 3 });

    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'INFO', status: 400 });
  });
});

describe('classifyPreviewFailure', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it.each([
    [new Error(EMPTY_PREVIEW_IMAGE_MESSAGE), 'empty_image'],
    [
      new Error('Chromium executable is not configured for preview rendering'),
      'chromium_unconfigured',
    ],
    [new Error('Requested scene was not found in the preview page (scene-1)'), 'scene_not_found'],
    [new Error('Failed to launch the browser process!\nstderr: ...'), 'browser_launch_failed'],
    [named('TimeoutError', 'Waiting for selector failed'), 'browser_timeout'],
    [
      named('TargetCloseError', 'Protocol error (Page.captureScreenshot): Target closed'),
      'browser_crashed',
    ],
    [new Error('Protocol error (Runtime.callFunctionOn): Session closed.'), 'browser_crashed'],
    [new Error('Navigating frame was detached'), 'browser_crashed'],
    [new Error('something else entirely'), 'internal'],
    ['not an error', 'internal'],
  ] as const)('maps %s to %s', (error, code) => {
    expect(classifyPreviewFailure(error)).toBe(code);
  });

  it('returns a code from the fixed vocabulary, never the message', () => {
    const code = classifyPreviewFailure(new Error('<div>scene markup from a model</div>'));
    expect(code).toBe('internal');
  });
});
