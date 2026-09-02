import { describe, expect, it } from 'vitest';
import {
  CHAT_WIDTH_DEFAULT,
  CHAT_WIDTH_MAX,
  CHAT_WIDTH_MIN,
  activateCourseTab,
  agentOwnsActiveCourse,
  agentOwnsPaneCourse,
  clampChatWidth,
  closeCourseTab,
  legacyWorkspaceHref,
  NO_PANES,
  parseChatWidth,
  parseCollapsed,
  pruneCourseTabs,
  openCourseTab,
  openCourseTabs,
  readWorkspacePanes,
  resolveWorkspaceRender,
  restoreCourseTabs,
  samePanes,
  withCourse,
  withSession,
  workspaceHref,
  workspaceLayout,
  type PaneCollapse,
} from '@/lib/workbench/workspace-panes';

const search = (query: string) => new URLSearchParams(query);

const OPEN: PaneCollapse = { nav: false, chat: false, classroom: false };

describe('reading panes out of the URL', () => {
  it('reads both params independently', () => {
    expect(readWorkspacePanes(search('?session=s1&course=c1'))).toEqual({
      sessionId: 's1',
      courseId: 'c1',
    });
    expect(readWorkspacePanes(search('?session=s1'))).toEqual({ sessionId: 's1', courseId: null });
    expect(readWorkspacePanes(search('?course=c1'))).toEqual({ sessionId: null, courseId: 'c1' });
    expect(readWorkspacePanes(search(''))).toEqual(NO_PANES);
  });

  it('treats an empty or whitespace param as absent', () => {
    // A truncated link must land on the home surface rather than attaching to
    // a session whose id is the empty string.
    expect(readWorkspacePanes(search('?session=&course=c1'))).toEqual({
      sessionId: null,
      courseId: 'c1',
    });
    expect(readWorkspacePanes(search('?session=%20%20'))).toEqual(NO_PANES);
  });

  it('round-trips through the canonical href', () => {
    const panes = { sessionId: 's/1', courseId: 'c 1' };
    const href = workspaceHref(panes);
    expect(href).toBe('/workspace?session=s%2F1&course=c%201');
    expect(readWorkspacePanes(new URL(`http://x${href}`).searchParams)).toEqual(panes);
  });

  it('spells one layout exactly one way', () => {
    expect(workspaceHref(NO_PANES)).toBe('/workspace');
    expect(workspaceHref({ sessionId: 's', courseId: null })).toBe('/workspace?session=s');
    expect(workspaceHref({ sessionId: null, courseId: 'c' })).toBe('/workspace?course=c');
    expect(workspaceHref({ sessionId: 's', courseId: 'c' })).toBe('/workspace?session=s&course=c');
  });

  it('names the four layouts', () => {
    expect(workspaceLayout(NO_PANES)).toBe('home');
    expect(workspaceLayout({ sessionId: 's', courseId: null })).toBe('session');
    expect(workspaceLayout({ sessionId: null, courseId: 'c' })).toBe('course');
    expect(workspaceLayout({ sessionId: 's', courseId: 'c' })).toBe('both');
  });

  it('compares pane states by value', () => {
    expect(samePanes({ sessionId: 's', courseId: 'c' }, { sessionId: 's', courseId: 'c' })).toBe(
      true,
    );
    expect(samePanes({ sessionId: 's', courseId: 'c' }, { sessionId: 's', courseId: 'd' })).toBe(
      false,
    );
  });
});

describe('opening things', () => {
  it('keeps the session attached when a course is opened', () => {
    expect(withCourse({ sessionId: 's', courseId: 'a' }, 'b')).toEqual({
      sessionId: 's',
      courseId: 'b',
    });
  });

  it('closes the classroom when the course is cleared', () => {
    expect(withCourse({ sessionId: 's', courseId: 'a' }, null)).toEqual({
      sessionId: 's',
      courseId: null,
    });
  });

  it('opens a session without touching the open course', () => {
    expect(withSession({ sessionId: null, courseId: 'a' }, 's')).toEqual({
      sessionId: 's',
      courseId: 'a',
    });
  });

  it('switches sessions without restoring session-specific classroom state', () => {
    expect(withSession({ sessionId: 'old', courseId: 'a' }, 'new')).toEqual({
      sessionId: 'new',
      courseId: 'a',
    });
  });

  it('leaves the open course alone when the same session is re-opened', () => {
    const panes = { sessionId: 's', courseId: 'a' };
    expect(withSession(panes, 's')).toBe(panes);
  });

  it('detaches the session without touching the course', () => {
    expect(withSession({ sessionId: 's', courseId: 'a' }, null)).toEqual({
      sessionId: null,
      courseId: 'a',
    });
  });
});

describe('ordered course tabs', () => {
  it('restores the workspace remembered set and active tab', () => {
    const remembered = { courseIds: ['a', 'b'], activeCourseId: 'a' };
    expect(restoreCourseTabs(remembered, null)).toBe(remembered);
  });

  it('leaves the pane shut when the workspace has no remembered set', () => {
    expect(restoreCourseTabs(null, null)).toEqual({ courseIds: [], activeCourseId: null });
  });

  it('lets a rail entry join the same ordered set', () => {
    expect(openCourseTab({ courseIds: ['a'], activeCourseId: 'a' }, 'b')).toEqual({
      courseIds: ['a', 'b'],
      activeCourseId: 'b',
    });
  });

  it('activates a duplicate open rather than adding it again', () => {
    expect(openCourseTab({ courseIds: ['a', 'b'], activeCourseId: 'b' }, 'a')).toEqual({
      courseIds: ['a', 'b'],
      activeCourseId: 'a',
    });
  });

  it('keeps URL-active content in the remembered set and makes it active', () => {
    expect(restoreCourseTabs({ courseIds: ['a'], activeCourseId: 'a' }, 'linked')).toEqual({
      courseIds: ['a', 'linked'],
      activeCourseId: 'linked',
    });
  });

  it('shuts stale remembered content instead of guessing another active tab', () => {
    expect(
      pruneCourseTabs({ courseIds: ['live', 'deleted'], activeCourseId: 'deleted' }, ['live']),
    ).toEqual({ courseIds: [], activeCourseId: null });
    expect(
      pruneCourseTabs({ courseIds: ['live', 'deleted'], activeCourseId: 'live' }, ['live']),
    ).toEqual({ courseIds: ['live'], activeCourseId: 'live' });
  });

  it('closes the active tab onto its next neighbour and remembers explicit closes', () => {
    const afterFirstClose = closeCourseTab(
      { courseIds: ['a', 'b', 'c'], activeCourseId: 'b' },
      'b',
    );
    expect(afterFirstClose).toEqual({
      courseIds: ['a', 'c'],
      activeCourseId: 'c',
      closedCourseIds: ['b'],
    });
    expect(closeCourseTab({ courseIds: ['a'], activeCourseId: 'a' }, 'a')).toEqual({
      courseIds: [],
      activeCourseId: null,
      closedCourseIds: ['a'],
    });
  });

  it('removes a manually reopened course from the closed set', () => {
    expect(
      openCourseTab({ courseIds: ['a'], activeCourseId: 'a', closedCourseIds: ['b'] }, 'b'),
    ).toEqual({ courseIds: ['a', 'b'], activeCourseId: 'b' });
  });

  it('activates only courses already in the set', () => {
    const tabs = { courseIds: ['a', 'b'], activeCourseId: 'a' };
    expect(activateCourseTab(tabs, 'b')).toEqual({ courseIds: ['a', 'b'], activeCourseId: 'b' });
    expect(activateCourseTab(tabs, 'missing')).toBe(tabs);
  });

  it('opens a batch in creation order with the newest in front', () => {
    // The agent-created case: one create_stage per classroom, so the strip ends
    // up in the order the run built them and the one just minted is on screen.
    expect(openCourseTabs({ courseIds: [], activeCourseId: null }, ['d1', 'd2', 'd3'])).toEqual({
      courseIds: ['d1', 'd2', 'd3'],
      activeCourseId: 'd3',
    });
    // A batch joins whatever the user already had open, and a classroom that is
    // already a tab is not duplicated — it is only brought to the front.
    expect(openCourseTabs({ courseIds: ['a', 'd1'], activeCourseId: 'a' }, ['d1', 'd2'])).toEqual({
      courseIds: ['a', 'd1', 'd2'],
      activeCourseId: 'd2',
    });
  });

  it('returns the same tabs object when a batch changes nothing', () => {
    // The shell compares identity before writing the URL and the tab memory, so
    // a no-op batch must not look like a change.
    const tabs = { courseIds: ['a', 'b'], activeCourseId: 'b' };
    expect(openCourseTabs(tabs, [])).toBe(tabs);
    expect(openCourseTabs(tabs, ['b'])).toBe(tabs);
  });

  it('evaluates the attached stage against the active URL course only', () => {
    expect(agentOwnsActiveCourse({ sessionId: 's', courseId: 'active' }, 'active')).toBe(true);
    expect(agentOwnsActiveCourse({ sessionId: 's', courseId: 'active' }, 'background')).toBe(false);
  });
});

describe('agentOwnsPaneCourse compatibility predicate', () => {
  const own = (overrides: Record<string, unknown> = {}) =>
    agentOwnsPaneCourse({
      panes: { sessionId: 'session-1', courseId: 'stage-a' },
      sessionStageId: 'stage-birth',
      attachedSessionId: 'session-1',
      status: 'running',
      stageLinkStageIds: [],
      touchedStageIds: ['stage-a'],
      ...overrides,
    } as never);

  it('keeps birth-stage plus link/touch fallbacks while live', () => {
    expect(own()).toBe(true);
    expect(own({ touchedStageIds: [], stageLinkStageIds: ['stage-a'] })).toBe(true);
    expect(own({ touchedStageIds: [], sessionStageId: 'stage-a' })).toBe(true);
    expect(own({ panes: { sessionId: 'session-1', courseId: 'stage-other' } })).toBe(false);
    expect(own({ attachedSessionId: 'session-other' })).toBe(false);
  });

  it('releases the relationship in every terminal state', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(own({ status }), status).toBe(false);
      expect(
        own({ status, stageLinkStageIds: ['stage-a'], sessionStageId: 'stage-a' }),
        status,
      ).toBe(false);
    }
  });

  it('retains it while queued or connecting', () => {
    expect(own({ status: 'queued' })).toBe(true);
    expect(own({ status: 'connecting' })).toBe(true);
  });
});

describe('legacy /classroom links', () => {
  it('maps a workbench link onto the three-pane surface', () => {
    expect(legacyWorkspaceHref('stage-1', 'sess-1')).toBe(
      '/workspace?session=sess-1&course=stage-1',
    );
  });

  it('leaves a bare classroom link alone', () => {
    expect(legacyWorkspaceHref('stage-1', null)).toBeNull();
    expect(legacyWorkspaceHref('stage-1', '  ')).toBeNull();
    expect(legacyWorkspaceHref('', 'sess-1')).toBeNull();
  });
});

describe('what the shell renders', () => {
  it('shows the home surface with nothing open', () => {
    const render = resolveWorkspaceRender({ panes: NO_PANES, collapse: OPEN, playback: false });
    expect(render).toMatchObject({
      home: true,
      chat: false,
      classroom: false,
      navRail: false,
    });
  });

  it('shows the conversation as the whole content area with a session only', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: null },
      collapse: OPEN,
      playback: false,
    });
    expect(render).toMatchObject({ chat: true, classroom: false, home: false });
    expect(render).not.toHaveProperty('emptyHint');
  });

  it('shows the classroom alone with a course only', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: null, courseId: 'c' },
      collapse: OPEN,
      playback: false,
    });
    expect(render).toMatchObject({ chat: false, classroom: true, home: false });
  });

  it('gives an empty, not-yet-created conversation the same column a real one gets', () => {
    // Nothing is minted when a course is opened any more; the middle column holds
    // a composer whose first message creates the session. As far as the layout is
    // concerned that IS the conversation — it just has no id yet.
    const render = resolveWorkspaceRender({
      panes: { sessionId: null, courseId: 'c' },
      collapse: OPEN,
      playback: false,
      draftConversation: true,
    });
    expect(render).toMatchObject({ chat: true, classroom: true, home: false });
  });

  it('shows all three with both open', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: 'c' },
      collapse: OPEN,
      playback: false,
    });
    expect(render).toMatchObject({ chat: true, classroom: true, home: false });
  });

  it('keeps chat visible and turns a collapsed classroom into its reopen tab', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: 'c' },
      collapse: { nav: true, chat: true, classroom: true },
      playback: false,
    });
    expect(render).toMatchObject({
      navRail: true,
      chat: true,
      chatTab: false,
      classroom: false,
      classroomTab: true,
    });
  });

  it('lets the global minimise flag win when a chat restores remembered tabs', () => {
    const restored = restoreCourseTabs({ courseIds: ['a', 'b'], activeCourseId: 'b' }, null);
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: restored.activeCourseId },
      collapse: { nav: false, chat: false, classroom: true },
      playback: false,
    });
    expect(restored).toEqual({ courseIds: ['a', 'b'], activeCourseId: 'b' });
    expect(render).toMatchObject({ classroom: false, classroomTab: true });
  });

  it('does not offer a reopen tab for a pane that is not open at all', () => {
    const render = resolveWorkspaceRender({
      panes: NO_PANES,
      collapse: { nav: false, chat: true, classroom: true },
      playback: false,
    });
    expect(render).toMatchObject({ chatTab: false, classroomTab: false, home: true });
  });

  it('never lets a stale chat-collapse preference create an empty content area', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: 'c' },
      collapse: { nav: false, chat: true, classroom: true },
      playback: false,
    });
    expect(render).toMatchObject({ chat: true, chatTab: false, classroom: false });
    expect(render).not.toHaveProperty('emptyHint');
  });

  it('folds the conversation to its strip when a classroom is there to take the column', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: 'c' },
      collapse: { nav: false, chat: true, classroom: false },
      playback: false,
    });
    expect(render).toMatchObject({
      chat: false,
      chatTab: true,
      classroom: true,
      classroomTab: false,
    });
  });

  it('refuses to fold the conversation when it is the only content pane', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: null },
      collapse: { nav: false, chat: true, classroom: false },
      playback: false,
    });
    expect(render).toMatchObject({ chat: true, chatTab: false, classroom: false });
  });

  it('keeps a folded conversation out of full-screen playback entirely', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: 'c' },
      collapse: { nav: false, chat: true, classroom: false },
      playback: true,
    });
    expect(render).toMatchObject({ chat: false, chatTab: false, classroom: true });
  });

  it('never exposes an empty-state rendering branch', () => {
    for (const panes of [
      NO_PANES,
      { sessionId: null, courseId: 'c' },
      { sessionId: 's', courseId: 'c' },
    ]) {
      const render = resolveWorkspaceRender({ panes, collapse: OPEN, playback: false });
      expect(render).not.toHaveProperty('emptyHint');
    }
  });

  it('suppresses everything but the classroom in full-screen playback', () => {
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: 'c' },
      collapse: OPEN,
      playback: true,
    });
    expect(render).toEqual({
      navRail: false,
      chat: false,
      chatTab: false,
      classroom: true,
      classroomTab: false,
      home: false,
    });
  });

  it('ignores a stale playback flag when no course is open', () => {
    // The flag is session state and survives closing the course; it must not
    // be able to blank the whole surface.
    const render = resolveWorkspaceRender({
      panes: { sessionId: 's', courseId: null },
      collapse: OPEN,
      playback: true,
    });
    expect(render).toMatchObject({ chat: true, classroom: false });
    expect(render).not.toHaveProperty('emptyHint');
  });
});

describe('persisted pane preferences', () => {
  it('clamps the chat width into the supported band', () => {
    expect(clampChatWidth(10)).toBe(CHAT_WIDTH_MIN);
    expect(clampChatWidth(9999)).toBe(CHAT_WIDTH_MAX);
    expect(clampChatWidth(Number.NaN)).toBe(CHAT_WIDTH_DEFAULT);
    expect(clampChatWidth(420.4)).toBe(420);
  });

  it('degrades a missing or corrupt stored width to the default', () => {
    expect(parseChatWidth(null)).toBe(CHAT_WIDTH_DEFAULT);
    expect(parseChatWidth('nonsense')).toBe(CHAT_WIDTH_DEFAULT);
    expect(parseChatWidth('420')).toBe(420);
  });

  it('reads only an exact flag as collapsed', () => {
    expect(parseCollapsed('1')).toBe(true);
    expect(parseCollapsed('0')).toBe(false);
    expect(parseCollapsed(null)).toBe(false);
    expect(parseCollapsed('true')).toBe(false);
  });
});
