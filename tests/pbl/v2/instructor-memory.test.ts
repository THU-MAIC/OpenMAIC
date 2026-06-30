/**
 * Tests for the Instructor thread memory compression.
 */
import { describe, it, expect } from 'vitest';
import {
  compressIfNeeded,
  COMPRESS_THRESHOLD,
  MAX_EARLIER_SUMMARY_CHARS,
} from '@/lib/pbl/v2/agents/instructor-memory';
import type { PBLAgentThread, PBLChatMessage } from '@/lib/pbl/v2/types';

function makeThread(messageCount: number): PBLAgentThread {
  const messages: PBLChatMessage[] = [];
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      id: `msg-${i}`,
      roleType: i % 2 === 0 ? 'user' : 'instructor',
      content: i % 2 === 0 ? `user msg #${i}` : `instructor reply #${i}`,
      ts: new Date(Date.UTC(2026, 4, 26, 12, 0, i)).toISOString(),
    });
  }
  return { agentId: 'role-instructor', messages };
}

describe('PBL v2 — instructor memory compression', () => {
  it('returns the thread unchanged when below threshold', () => {
    const thread = makeThread(COMPRESS_THRESHOLD - 1);
    const out = compressIfNeeded(thread);
    expect(out).toBe(thread); // same reference, no work done
  });

  it('compresses when above threshold', () => {
    const thread = makeThread(COMPRESS_THRESHOLD + 10);
    const out = compressIfNeeded(thread);
    expect(out.messages.length).toBeLessThan(thread.messages.length);
    expect(out.earlierSummary).toBeDefined();
    expect(out.earlierSummary).toContain('Earlier conversation digest');
  });

  it('cuts on a user-message boundary so a turn pair is never split', () => {
    const thread = makeThread(COMPRESS_THRESHOLD + 10);
    const out = compressIfNeeded(thread);
    // After cut, the first surviving message should be a user message
    // (digestor invariant).
    if (out.messages.length > 0) {
      expect(out.messages[0].roleType).toBe('user');
    }
  });

  it('concatenates with prior earlierSummary instead of replacing it', () => {
    const thread = makeThread(COMPRESS_THRESHOLD + 10);
    thread.earlierSummary = 'PRIOR_SUMMARY_MARKER';
    const out = compressIfNeeded(thread);
    expect(out.earlierSummary).toContain('PRIOR_SUMMARY_MARKER');
    expect(out.earlierSummary).toContain('Earlier conversation digest');
  });

  it('extracts durable learner context from folded turns', () => {
    const thread = makeThread(COMPRESS_THRESHOLD + 10);
    thread.messages[4].content = '我是零基础，想最简单一点。';
    thread.messages[8].content = '我用 VS Code 和终端，Python 已经装好了。';
    thread.messages[12].content = '这里报错了，我看不懂 traceback。';
    const out = compressIfNeeded(thread);
    expect(out.earlierSummary).toContain('Learner context inferred');
    expect(out.earlierSummary).toContain('Level/preference');
    expect(out.earlierSummary).toContain('Environment/tools');
    expect(out.earlierSummary).toContain('Blocker/confusion');
  });

  it('keeps folded memory bounded across repeated compressions', () => {
    let thread = makeThread(COMPRESS_THRESHOLD + 10);
    thread.earlierSummary = 'x'.repeat(MAX_EARLIER_SUMMARY_CHARS + 2000);
    thread = compressIfNeeded(thread);
    expect(thread.earlierSummary!.length).toBeLessThanOrEqual(MAX_EARLIER_SUMMARY_CHARS + 120);
  });
});
