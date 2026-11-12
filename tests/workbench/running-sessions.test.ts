import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { courseIsComplete, moreIsComing } from '@/lib/classroom/course-end';
import { producerSessionRunning, useRunningSessions } from '@/lib/workbench/running-sessions';
import { sessionBuildsCourse } from '@/lib/workbench/session-store';

const COURSE_B_PRODUCER = 'f09ade2b-f871-4b7d-87d4-9e0bb46f387d';

afterEach(() => useRunningSessions.getState().setFromSessions([]));

describe('a course another conversation is still building', () => {
  it('knows its producer conversation is running from the rail list', () => {
    useRunningSessions.getState().setFromSessions([
      { id: 'attached-chat', status: 'running' },
      { id: COURSE_B_PRODUCER, status: 'running' },
      { id: 'done-chat', status: 'succeeded' },
    ]);
    const { ids } = useRunningSessions.getState();
    expect(producerSessionRunning(ids, COURSE_B_PRODUCER, 'attached-chat')).toBe(true);
    expect(producerSessionRunning(ids, 'done-chat', 'attached-chat')).toBe(false);
    expect(producerSessionRunning(ids, null, 'attached-chat')).toBe(false);
  });

  it('is not finished at its last page while that conversation runs, and is once it ends', () => {
    // An agent-built course: born complete, every outline has its page so far.
    const build = {
      generationComplete: true,
      outlineCount: 9,
      sceneCount: 9,
      generatingCount: 0,
    };
    useRunningSessions.getState().setFromSessions([{ id: COURSE_B_PRODUCER, status: 'running' }]);
    const building = producerSessionRunning(
      useRunningSessions.getState().ids,
      COURSE_B_PRODUCER,
      null,
    );
    expect(moreIsComing({ ...build, agentBuilding: building })).toBe(true);
    expect(courseIsComplete({ ...build, agentBuilding: building })).toBe(false);

    useRunningSessions.getState().setFromSessions([{ id: COURSE_B_PRODUCER, status: 'succeeded' }]);
    const ended = producerSessionRunning(
      useRunningSessions.getState().ids,
      COURSE_B_PRODUCER,
      null,
    );
    expect(courseIsComplete({ ...build, agentBuilding: ended })).toBe(true);
  });

  it('leaves the attached producer to the course-specific check, so an unrelated follow-up does not hold the end back', () => {
    // The producer is the attached conversation, running a follow-up that does
    // not write this course: only `sessionBuildsCourse` decides, and it says no.
    useRunningSessions.getState().setFromSessions([{ id: COURSE_B_PRODUCER, status: 'running' }]);
    const { ids } = useRunningSessions.getState();
    expect(producerSessionRunning(ids, COURSE_B_PRODUCER, COURSE_B_PRODUCER)).toBe(false);
    const followUp = { status: 'running' as const, runCourseStageIds: [] as string[] };
    expect(sessionBuildsCourse(followUp, 'course-b')).toBe(false);
    const build = { generationComplete: true, outlineCount: 9, sceneCount: 9, generatingCount: 0 };
    expect(courseIsComplete({ ...build, agentBuilding: false })).toBe(true);

    // The same attached run writing this course still holds it back.
    const writing = { status: 'running' as const, runCourseStageIds: ['course-b'] };
    expect(sessionBuildsCourse(writing, 'course-b')).toBe(true);
  });

  it('keeps the same set while nothing changed, so subscribers do not re-render', () => {
    useRunningSessions.getState().setFromSessions([{ id: 'a', status: 'queued' }]);
    const first = useRunningSessions.getState().ids;
    useRunningSessions.getState().setFromSessions([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'failed' },
    ]);
    expect(useRunningSessions.getState().ids).toBe(first);
  });

  it('is wired: the shell publishes the list, the classroom reads its producer', () => {
    const shell = readFileSync(
      resolve(process.cwd(), 'components/workbench/workspace/WorkspaceShell.tsx'),
      'utf8',
    );
    const chrome = readFileSync(
      resolve(process.cwd(), 'components/edit/PlaybackChromeRoot.tsx'),
      'utf8',
    );
    expect(shell).toContain('setRunningSessions(sessions);');
    expect(chrome).toContain(
      'producerSessionRunning(s.ids, outlineProducerRef, attachedSessionId)',
    );
    expect(chrome).toContain('const agentBuilding = attachedRunBuilding || producerBuilding;');
  });
});
