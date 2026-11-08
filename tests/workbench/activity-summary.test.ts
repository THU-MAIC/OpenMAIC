import { describe, expect, it } from 'vitest';
import { summarizeActivity } from '@/components/workbench/chat/activity-summary';
import type { ChatNode } from '@/lib/workbench/session-store';

const done = (key: string, startedAt = 0, endedAt = 0): ChatNode => ({
  key,
  kind: 'tool',
  text: '',
  toolName: 'read_scene',
  toolState: 'done',
  toolStartedAt: startedAt,
  toolEndedAt: endedAt,
});
const failed = (key: string, reason = '语音没能合成'): ChatNode => ({
  ...done(key),
  toolState: 'failed',
  toolResultText: reason,
});
const running = (key: string): ChatNode => ({
  key,
  kind: 'tool',
  text: '',
  toolName: 'read_scene',
  toolState: 'running',
});
const thought = (key: string, startedAt = 0, endedAt = 0): ChatNode => ({
  key,
  kind: 'thinking',
  text: '想一想',
  startedAt,
  endedAt,
});

describe('summarizeActivity', () => {
  it('counts tools and notes that it thought, with the time from first start to last end', () => {
    const summary = summarizeActivity([thought('a', 1000, 2000), done('b', 2000, 5000)]);
    expect(summary).toMatchObject({
      status: 'done',
      thought: true,
      toolCount: 1,
      failedCount: 0,
      durationMs: 4000,
    });
  });

  it('counts a failure the stretch went on past, without a reason or an alarm', () => {
    const summary = summarizeActivity([failed('a'), done('b')]);
    expect(summary).toMatchObject({ status: 'done', failedCount: 1 });
    expect(summary.failureReason).toBeUndefined();
  });

  it('gives the reason when the stretch stopped on the failure', () => {
    const summary = summarizeActivity([done('a'), failed('b')]);
    expect(summary.status).toBe('done');
    expect(summary.failureReason).toContain('语音没能合成');
  });

  it('names the running step rather than a count', () => {
    const summary = summarizeActivity([done('a'), running('b')]);
    expect(summary.status).toBe('running');
    expect(summary.live).toBeTruthy();
    expect(summary.durationMs).toBeUndefined();
  });

  it('holds the last step through the gap before the next one', () => {
    const gap = summarizeActivity([
      done('a'),
      thought('b'),
      done('c'),
      { key: 'w', kind: 'waiting', text: '' },
    ]);
    expect(gap.status).toBe('running');
    expect(gap.live).toBe(summarizeActivity([running('c')]).live);
  });

  it('stays running between events while the turn goes on', () => {
    const between = summarizeActivity([done('a'), done('b')], [], undefined, true);
    expect(between.status).toBe('running');
    expect(between.live).toBe(summarizeActivity([running('b')]).live);
  });

  it('says it is thinking while a thought streams', () => {
    const summary = summarizeActivity([done('a'), { ...thought('b'), streaming: true }]);
    expect(summary.status).toBe('running');
    expect(summary.live).toBe('思考中…');
  });
});
