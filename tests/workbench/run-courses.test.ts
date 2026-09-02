import { describe, expect, it } from 'vitest';
import {
  appendCourseSighting,
  courseSightingsOf,
  runCourseStageIds,
} from '@/lib/workbench/run-courses';
// Upstream adaptation: the reference's last describe (`folding one exchange's
// cards`) exercised `splitRunCourseCards` from `lib/workbench/course-link`,
// which ships with the workbench UI slice — dropped here, not ported.

/**
 * What counts as "this frame put a classroom in front of the user".
 *
 * This replaced a session-level derivation plus a stored ignore list. The rule is
 * now per-exchange (one question and its answer) and needs no correcting, but the
 * SOURCES are inherited verbatim — including the one deliberate exclusion, which
 * is the whole reason the list is usable at all.
 */
describe('what a frame counts as a classroom sighting', () => {
  const at = (type: string, data: unknown) => courseSightingsOf({ type, data });

  it('reads a stage link, under either event name', () => {
    expect(at('stage_link', { stageId: 'stage-a', title: 'x', url: '/classroom/stage-a' })).toEqual(
      ['stage-a'],
    );
    // Pre-rename logs still carry `course_link` and mean exactly the same thing.
    expect(at('course_link', { stageId: 'stage-a' })).toEqual(['stage-a']);
  });

  it('reads a checkpoint’s write receipt', () => {
    expect(at('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', order: 1 })).toEqual([
      'stage-a',
    ]);
    // A v1 page checkpoint carried no stage id — nothing to name.
    expect(at('checkpoint', { tool: 'generate_scene', order: 1 })).toEqual([]);
  });

  it('reads a v1 transcript’s `stage_created`, and only that change', () => {
    expect(at('library_changed', { change: 'stage_created', stageId: 'stage-a' })).toEqual([
      'stage-a',
    ]);
    expect(at('library_changed', { change: 'folder_created', stageId: 'stage-a' })).toEqual([]);
    expect(at('library_changed', { change: 'stage_filed' })).toEqual([]);
  });

  it('reads a WRITER tool’s target and never a reader’s', () => {
    expect(
      at('tool_execution_start', {
        toolName: 'generate_scene',
        args: { stageId: 'stage-a', order: 1 },
      }),
    ).toEqual(['stage-a']);
    expect(
      at('tool_execution_start', { toolName: 'patch_stage', args: { stageId: 'stage-a' } }),
    ).toEqual(['stage-a']);
    // Looking around is how an agent works. A card for every classroom it opened
    // to read would turn the end of an answer into a search-result dump.
    for (const toolName of ['read_stage', 'grep_stage', 'search_classrooms', 'read_classroom']) {
      expect(
        at('tool_execution_start', { toolName, args: { stageId: 'stage-a' } }),
        toolName,
      ).toEqual([]);
    }
  });

  it('reads every classroom one message named, in the order it named them', () => {
    expect(
      at('user_message', {
        text: '对比这两节',
        courseRefs: [
          { kind: 'course', stageId: 'stage-b', title: '二次函数' },
          { kind: 'course', stageId: 'stage-a', title: '光的折射' },
        ],
      }),
    ).toEqual(['stage-b', 'stage-a']);
  });

  it('treats the durable log as untrusted', () => {
    expect(at('checkpoint', { stageId: '   ' })).toEqual([]);
    expect(at('checkpoint', { stageId: 42 })).toEqual([]);
    expect(at('stage_link', {})).toEqual([]);
    expect(at('tool_execution_start', { toolName: 'patch_stage', args: {} })).toEqual([]);
    expect(at('user_message', { courseRefs: 'stage-a' })).toEqual([]);
    expect(at('user_message', { courseRefs: [{ stageId: 'stage-a' }] })).toEqual([]);
    expect(courseSightingsOf({ type: 'checkpoint', data: null })).toEqual([]);
  });

  it('counts nothing for every other event type', () => {
    // `turn_end` and `agent_end` are listed deliberately: neither is a sighting.
    // `agent_end` is where the fold FLUSHES the buffer, and a flush frame that
    // also added to it would be a way to smuggle an extra id into the card set.
    for (const type of [
      'session_start',
      'message_end',
      'turn_end',
      'agent_end',
      'trace',
      'whatever_is_next',
    ]) {
      expect(at(type, { stageId: 'stage-a' }), type).toEqual([]);
    }
  });

  it('trims what it returns, so one classroom cannot become two ids', () => {
    expect(at('checkpoint', { stageId: '  stage-a  ' })).toEqual(['stage-a']);
  });
});

describe('one exchange’s ordered set', () => {
  it('is first-seen order, de-duplicated across every source', () => {
    expect(
      runCourseStageIds([
        {
          type: 'user_message',
          data: { courseRefs: [{ kind: 'course', stageId: 'stage-b', title: 'b' }] },
        },
        {
          type: 'tool_execution_start',
          data: { toolName: 'patch_stage', args: { stageId: 'stage-a' } },
        },
        { type: 'checkpoint', data: { stageId: 'stage-b', order: 1 } },
        {
          type: 'tool_execution_start',
          data: { toolName: 'read_stage', args: { stageId: 'stage-c' } },
        },
        { type: 'stage_link', data: { stageId: 'stage-a' } },
      ]),
    ).toEqual(['stage-b', 'stage-a']);
  });

  it('is a pure function of the range, so a replay of it is identical', () => {
    const events = [
      { type: 'checkpoint', data: { stageId: 'stage-a', order: 1 } },
      { type: 'checkpoint', data: { stageId: 'stage-b', order: 2 } },
    ];
    expect(runCourseStageIds(events)).toEqual(runCourseStageIds(events));
    // Order is the whole content of the answer: a different order is a different
    // answer, not the same set.
    expect(runCourseStageIds([...events].reverse())).toEqual(['stage-b', 'stage-a']);
  });

  it('is empty for an exchange that touched nothing', () => {
    expect(runCourseStageIds([{ type: 'message_end', data: {} }])).toEqual([]);
  });
});

describe('the buffer’s append keeps its identity when nothing changes', () => {
  it('returns the same array for a duplicate or an empty id', () => {
    const seen = ['stage-a'];
    expect(appendCourseSighting(seen, 'stage-a')).toBe(seen);
    expect(appendCourseSighting(seen, '')).toBe(seen);
    expect(appendCourseSighting(seen, 'stage-b')).toEqual(['stage-a', 'stage-b']);
  });
});
