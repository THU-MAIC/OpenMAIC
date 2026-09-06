/**
 * The event sink is the service's only operational output, so its shape is a
 * contract: one JSON line, bounded dimensions only, and a level that lets a
 * pipeline separate failures from routine transitions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitRenderEvent } from '../src/events.js';

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
      status: 504,
      durationMs: 20000,
    });

    expect(JSON.parse(lines[0]!)).toMatchObject({ component: 'preview', status: 504 });
  });
});
