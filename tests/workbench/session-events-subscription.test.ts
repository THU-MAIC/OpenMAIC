/**
 * The SSE subscription contract — the bug the first `ask_user` card died of.
 *
 * A native `EventSource` delivers a NAMED frame (`event: user_question`) only to
 * a listener registered for that exact name; it never reaches `onmessage`. The
 * browser's subscription list was a hand-typed copy of the runner's lifecycle
 * names, so `user_question` was written to the log, folded correctly, rendered
 * correctly — and dropped by the browser before any of our code ran. No error
 * anywhere: the card simply did not exist.
 *
 * The list is derived from `LIFECYCLE` now, and this file is what keeps it
 * derived: a lifecycle event the browser cannot receive fails here instead of
 * shipping as an invisible feature.
 */
import { describe, expect, it } from 'vitest';
// The upstream host names this export `HOST_AGENT_LIFECYCLE`; the reference
// calls it `LIFECYCLE`. The values are the same durable event names.
import { HOST_AGENT_LIFECYCLE as LIFECYCLE } from '@/lib/agent-runtime/lifecycle';
import {
  LEGACY_WORKBENCH_EVENT_TYPES,
  WORKBENCH_EVENT_TYPES,
} from '@/lib/workbench/use-workbench-session';

describe('workbench SSE subscription', () => {
  it('subscribes to EVERY runner lifecycle event', () => {
    const missing = Object.values(LIFECYCLE).filter(
      (type) => !WORKBENCH_EVENT_TYPES.includes(type),
    );
    expect(missing).toEqual([]);
  });

  it('subscribes to user_question by name', () => {
    // Named explicitly as well as by the loop above: this is the regression.
    expect(WORKBENCH_EVENT_TYPES).toContain('user_question');
    expect(WORKBENCH_EVENT_TYPES).toContain(LIFECYCLE.userQuestion);
  });

  it('subscribes to media_ready, the async media completion lifecycle event', () => {
    // generate_video settles in a detached background job and reports through
    // this frame; an unsubscribed name would be dropped by the browser before
    // the fold could see it (same failure mode as the first user_question).
    expect(LIFECYCLE.mediaReady).toBe('media_ready');
    expect(WORKBENCH_EVENT_TYPES).toContain('media_ready');
  });

  it('still subscribes to the legacy course_link name for pre-rename transcripts', () => {
    // A native EventSource drops a named frame unless a listener is registered
    // for that exact name. Historical session logs contain `course_link`
    // frames, so the browser must keep a listener for BOTH names even though
    // emitters only write `stage_link` now — the reducer folds them identically.
    expect(LEGACY_WORKBENCH_EVENT_TYPES).toContain('course_link');
    expect(WORKBENCH_EVENT_TYPES).toContain('course_link');
  });

  it('still subscribes to pi’s own agent events', () => {
    // The other half of the list, which the runner appends verbatim; a
    // refactor of the lifecycle half must not drop these.
    for (const type of [
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_start',
      'tool_execution_end',
      'turn_start',
      'turn_end',
      'agent_start',
      'agent_end',
    ]) {
      expect(WORKBENCH_EVENT_TYPES).toContain(type);
    }
  });

  it('has no duplicate subscriptions', () => {
    // Two listeners for one name would fold every such frame twice — harmless
    // today (the fold is idempotent on `lastEventId`) but not a property worth
    // leaning on.
    expect(new Set(WORKBENCH_EVENT_TYPES).size).toBe(WORKBENCH_EVENT_TYPES.length);
  });
});
