/**
 * A course still being built is not finished: its last page is a wait, not the end.
 *
 * The bug: an agent-built course is minted `generationComplete: true` and grows its
 * outline one page at a time, so between two pages every outline has its scene and
 * the classroom read it as complete — the end overlay played mid-build.
 */
import { describe, expect, it } from 'vitest';
import {
  courseIsComplete,
  moreIsComing,
  opensOnPlaybackEnd,
  opensWhenBuildEnds,
  waitsForNextPage,
  type CourseBuildState,
} from '@/lib/classroom/course-end';
import {
  createInitialSessionState,
  foldEvents,
  sessionBuildsCourse,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';

const build = (over: Partial<CourseBuildState> = {}): CourseBuildState => ({
  generationComplete: false,
  outlineCount: 3,
  sceneCount: 3,
  generatingCount: 0,
  agentBuilding: false,
  ...over,
});

describe('courseIsComplete', () => {
  it('is not complete while the agent is still building it, between two pages', () => {
    // Agent-minted: the flag is set from birth and every outline has its scene.
    const between = build({ generationComplete: true, agentBuilding: true });
    expect(courseIsComplete(between)).toBe(false);
    expect(moreIsComing(between)).toBe(true);
    // So the playback-end trigger on its last page cannot open the end.
    const ctx = {
      courseComplete: courseIsComplete(between),
      onLastPage: true,
      busy: false,
      fired: false,
    };
    expect(opensOnPlaybackEnd(ctx, 'slide')).toBe(false);
  });
  it('is complete once the build is over', () => {
    expect(courseIsComplete(build({ generationComplete: true }))).toBe(true);
  });
  it('keeps the classic one-shot rule: every outline built, nothing generating', () => {
    expect(courseIsComplete(build())).toBe(true);
    expect(courseIsComplete(build({ sceneCount: 2, generatingCount: 1 }))).toBe(false);
    expect(courseIsComplete(build({ sceneCount: 2 }))).toBe(false);
    expect(courseIsComplete(build({ outlineCount: 0, sceneCount: 0 }))).toBe(false);
  });
  it('keeps a finished deck with a deleted page complete by its flag', () => {
    expect(courseIsComplete(build({ generationComplete: true, sceneCount: 2 }))).toBe(true);
  });
  it('reads a static, fully built course (the guide) as complete', () => {
    expect(courseIsComplete(build({ generationComplete: true, outlineCount: 0 }))).toBe(true);
  });
});

describe('waitsForNextPage', () => {
  it('waits on the last page while more is coming and there is no placeholder page', () => {
    expect(waitsForNextPage({ moreComing: true, onLastPage: true, pendingPage: false })).toBe(true);
  });
  it('does not wait elsewhere, when nothing is coming, or when a pending page takes the wait', () => {
    expect(waitsForNextPage({ moreComing: true, onLastPage: false, pendingPage: false })).toBe(
      false,
    );
    expect(waitsForNextPage({ moreComing: false, onLastPage: true, pendingPage: false })).toBe(
      false,
    );
    expect(waitsForNextPage({ moreComing: true, onLastPage: true, pendingPage: true })).toBe(false);
  });
});

describe('opensWhenBuildEnds', () => {
  const ctx = { courseComplete: true, onLastPage: true, busy: false, fired: false };
  it('opens the end when the build finishes with the waited-on page last', () => {
    expect(opensWhenBuildEnds(ctx, false)).toBe(true);
    expect(opensWhenBuildEnds(ctx, true)).toBe(true);
  });
  it('opens by itself once a playthrough, by hand as often as asked', () => {
    expect(opensWhenBuildEnds({ ...ctx, fired: true }, false)).toBe(false);
    expect(opensWhenBuildEnds({ ...ctx, fired: true }, true)).toBe(true);
  });
  it('holds back if the learner moved away or a discussion is on', () => {
    expect(opensWhenBuildEnds({ ...ctx, onLastPage: false }, true)).toBe(false);
    expect(opensWhenBuildEnds({ ...ctx, busy: true }, false)).toBe(false);
  });
});

describe('sessionBuildsCourse', () => {
  let seq = 0;
  const ev = (type: string, data: unknown): WorkbenchEvent => {
    seq += 1;
    return { id: seq, ts: 1000 + seq, attempt: 1, type, data };
  };
  const start = [
    ev('session_start', { prompt: 'Teach fractions' }),
    ev('agent_start', {}),
    ev('tool_execution_start', {
      toolCallId: 'c1',
      toolName: 'generate_scene',
      args: { stageId: 'stage-a', order: 1 },
    }),
  ];

  it('is building while the live answer writes the course', () => {
    const state = foldEvents(createInitialSessionState(), start);
    expect(sessionBuildsCourse(state, 'stage-a')).toBe(true);
    expect(sessionBuildsCourse(state, 'stage-b')).toBe(false);
    expect(sessionBuildsCourse(state, null)).toBe(false);
  });
  it('stops building when the answer ends, or the run does', () => {
    const answered = foldEvents(createInitialSessionState(), [...start, ev('agent_end', {})]);
    expect(sessionBuildsCourse(answered, 'stage-a')).toBe(false);
    const failed = foldEvents(createInitialSessionState(), [
      ...start,
      ev('session_end', { status: 'failed' }),
    ]);
    expect(sessionBuildsCourse(failed, 'stage-a')).toBe(false);
  });
  it('is never building with no run attached', () => {
    expect(sessionBuildsCourse(createInitialSessionState(), 'stage-a')).toBe(false);
  });
});
