// @vitest-environment node

/**
 * The first bubble's course receipt.
 *
 * A launch-composer message names classrooms the same way any later message
 * does, but it travels differently: there is no session yet, so the refs ride
 * the creation request onto the session ROW and the runner injects them from
 * there. The row, however, is not something the chat fold reads — pills come
 * from the durable log and nothing else, deliberately, so replay and live agree
 * and no session-level list becomes a second source of "what this message
 * said". The consequence, before this seam was closed, was a first bubble with
 * no receipt while every later bubble had one.
 *
 * So both ends are pinned here together: the event the runner writes, and the
 * node the fold paints from it — plus the property that actually matters to the
 * reader, which is that the two paths produce the SAME receipt.
 */
import { describe, expect, it } from 'vitest';

import {
  createInitialSessionState,
  foldEvent,
  type WorkbenchEvent,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';
import type { CourseRef } from '@/lib/workbench/course-refs';

// Upstream adaptation: the reference built the `session_start` payload with the
// runner's `sessionStartEventData` helper (`lib/server/agent-runtime/runner`),
// which the upstream runner does not export yet. The wire shape it produced is
// reproduced inline (prompt + optional courseRefs, the field omitted entirely
// when nothing was named) — a seam for the runner slice to close.
function sessionStartEventData(input: {
  prompt: string;
  courseRefs?: readonly CourseRef[];
}): Record<string, unknown> {
  return input.courseRefs?.length
    ? { prompt: input.prompt, courseRefs: input.courseRefs }
    : { prompt: input.prompt };
}

const ref = (stageId: string, title: string): CourseRef => ({ kind: 'course', stageId, title });

const seed = (): WorkbenchFold => createInitialSessionState();

function event(type: string, data: unknown): WorkbenchEvent {
  return { id: 1, ts: 1000, attempt: 1, type, data };
}

function firstUserNode(fold: WorkbenchFold) {
  const node = fold.chat.find((entry) => entry.kind === 'user');
  if (!node) throw new Error('no user bubble was painted');
  return node;
}

describe('session_start course receipt', () => {
  it('puts the named classrooms on the event, next to the prompt', () => {
    const named = [ref('stage-a', '《傲慢与偏见》文学导读')];

    const data = sessionStartEventData({ prompt: '帮我在这门课程中增加内容', courseRefs: named });

    expect(data.prompt).toBe('帮我在这门课程中增加内容');
    expect(data.courseRefs).toEqual(named);
  });

  it('leaves the field off entirely when nothing was named', () => {
    expect(sessionStartEventData({ prompt: '做一门新课' })).not.toHaveProperty('courseRefs');
    expect(sessionStartEventData({ prompt: '做一门新课', courseRefs: [] })).not.toHaveProperty(
      'courseRefs',
    );
  });

  it('paints the same receipt the same refs would get on a later message', () => {
    const named = [ref('stage-a', '光的折射'), ref('stage-b', '光的反射')];

    const first = foldEvent(
      seed(),
      event('session_start', sessionStartEventData({ prompt: '两节课都改', courseRefs: named })),
    );
    const later = foldEvent(
      seed(),
      event('user_message', { text: '两节课都改', courseRefs: named }),
    );

    expect(firstUserNode(first)).toMatchObject({ text: '两节课都改', courseRefs: named });
    expect(firstUserNode(first).courseRefs).toEqual(firstUserNode(later).courseRefs);
  });

  it('drops a malformed entry rather than painting a false pill', () => {
    // Same untrusted-log rule as `user_message`: a legacy or corrupt row loses
    // the bad entry, not the whole bubble.
    const folded = foldEvent(
      seed(),
      event('session_start', {
        prompt: '改一下',
        courseRefs: [{ kind: 'course' }, ref('stage-b', '能量守恒')],
      }),
    );

    expect(firstUserNode(folded).courseRefs).toEqual([ref('stage-b', '能量守恒')]);
  });

  it('keeps a bubble that named nothing free of the field', () => {
    const folded = foldEvent(seed(), event('session_start', { prompt: '做一门新课' }));

    expect(firstUserNode(folded).text).toBe('做一门新课');
    expect(firstUserNode(folded)).not.toHaveProperty('courseRefs');
  });
});
