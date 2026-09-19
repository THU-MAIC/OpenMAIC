import { describe, expect, it } from 'vitest';

import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import {
  isOverAttemptCap,
  LENGTH_STOP_ERROR,
  markRunEventEmitted,
  planUndeliveredRequeue,
  terminalLoopError,
} from '@/lib/server/agent-runtime/runner';

describe('runner correctness helpers', () => {
  it('requires a lifecycle event to anchor each run', () => {
    expect(markRunEventEmitted(false, 'checkpoint')).toBe(false);
    expect(markRunEventEmitted(false, 'session_start')).toBe(true);
    expect(markRunEventEmitted(true, 'checkpoint')).toBe(true);
  });

  it('turns a final length stop into a visible failure', () => {
    expect(
      terminalLoopError(
        [{ role: 'assistant', content: [], stopReason: 'length' } as never],
        undefined,
      ),
    ).toBe(LENGTH_STOP_ERROR);
    expect(terminalLoopError([], 'provider failed')).toBe('provider failed');
  });

  it('allows the cap attempt and rejects later verdict claims', () => {
    expect(isOverAttemptCap({ attempt: agentRuntimeConfig.maxAttempts })).toBe(false);
    expect(isOverAttemptCap({ attempt: agentRuntimeConfig.maxAttempts + 1 })).toBe(true);
  });
});

describe('one knock, one redemption', () => {
  const message = (seq: number) => ({ seq, ts: 0 });

  it('does nothing when every message is handled', () => {
    expect(
      planUndeliveredRequeue({
        logged: [message(1)],
        deliveredThrough: 1,
        claimSeq: 10,
        atVerdict: false,
      }),
    ).toBe('none');
  });

  it('resets for a post-claim message, including in the verdict window', () => {
    expect(
      planUndeliveredRequeue({
        logged: [message(11)],
        deliveredThrough: 0,
        claimSeq: 10,
        atVerdict: true,
      }),
    ).toBe('reset');
  });

  it('preserves the chain for inherited work and stops at the verdict', () => {
    const input = { logged: [message(9)], deliveredThrough: 0, claimSeq: 10 };
    expect(planUndeliveredRequeue({ ...input, atVerdict: false })).toBe('retry');
    expect(planUndeliveredRequeue({ ...input, atVerdict: true })).toBe('none');
  });

  it('does not rescue an opening message already delivered by the run', () => {
    const input = { logged: [message(1)], deliveredThrough: 1, claimSeq: 1 };
    expect(planUndeliveredRequeue({ ...input, atVerdict: false })).toBe('none');
    expect(planUndeliveredRequeue({ ...input, atVerdict: false })).toBe('none');
  });

  it('rescues only a message beyond the final delivery watermark', () => {
    expect(
      planUndeliveredRequeue({
        logged: [message(1), message(3)],
        deliveredThrough: 1,
        claimSeq: 1,
        atVerdict: false,
      }),
    ).toBe('reset');
  });
});
