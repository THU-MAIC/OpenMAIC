import { describe, expect, it } from 'vitest';
import { requestCourse } from '@/lib/workbench/conversation-course';
import {
  createInitialSessionState,
  foldEvent,
  type ChatNode,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';

const user = (key: string, text = 'x'): ChatNode => ({ key, kind: 'user', text });
const tool = (
  key: string,
  toolName: string,
  extra: Partial<ChatNode> = {},
  toolArgs?: Record<string, unknown>,
): ChatNode => ({
  key,
  kind: 'tool',
  text: '',
  toolName,
  toolState: 'done',
  ...(toolArgs ? { toolArgs } : {}),
  ...extra,
});
const created = (key: string, stageId: string): ChatNode =>
  tool(key, 'create_stage', { toolDetails: { stageId } });
const page = (key: string, stageId: string, sceneId = `${key}-scene`): ChatNode =>
  tool(key, 'generate_scene', { sceneId }, { stageId, order: 1 });
const question = (key: string): ChatNode => ({ key, kind: 'question', text: 'Which one?' });

describe('rule 1: a conversation started beside an existing course', () => {
  it('works on that course: no preview, whatever the agent looks through', () => {
    const chat = [
      user('u', 'shorten the title of page 2'),
      tool('l', 'list_folder_stages'),
      tool('r', 'read_stage', {}, { stageId: 'stage-a' }),
      question('q'),
    ];
    expect(requestCourse(chat, true, 'stage-a')).toEqual({ kind: 'course', courseId: 'stage-a' });
  });

  it('then works on the course it created, once that course has pages', () => {
    const chat = [
      user('u1', 'make a sequel of this course'),
      created('c', 'stage-new'),
      page('p', 'stage-new'),
      user('u2', 'change the roster of this course'),
      tool('r', 'set_roster'),
    ];
    expect(requestCourse(chat, true, 'stage-a')).toEqual({
      kind: 'course',
      courseId: 'stage-new',
    });
  });

  it('shows nothing while the flag is not known yet, so nothing flashes', () => {
    expect(requestCourse([user('u'), tool('s', 'web_search')], null)).toEqual({
      kind: 'course',
      courseId: null,
    });
  });

  it('gets a preview for a course it creates (rule 4 applies to that one)', () => {
    const chat = [user('u', 'make a grade-5 version of this course'), tool('c', 'create_stage')];
    expect(requestCourse(chat, true)).toEqual({ kind: 'new', ready: [] });
  });

  it('does not take a page written to the bound course for the new one', () => {
    const chat = [
      user('u'),
      page('p0', 'stage-a'),
      created('c', 'stage-new'),
      page('p1', 'stage-a'),
      page('p2', 'stage-new'),
    ];
    expect(requestCourse(chat, true)).toEqual({ kind: 'new', ready: ['stage-new'] });
  });
});

describe('rule 2: a new conversation', () => {
  it('is making a course from its first request, even if the agent looks through the library', () => {
    // The bug this model replaced: every session carries a stage id, so a new
    // request that called list_folder_stages read as "on existing courses".
    const chat = [user('u', '图文并茂'), tool('l', 'list_folder_stages'), question('q')];
    expect(requestCourse(chat, false)).toEqual({ kind: 'new', ready: [] });
  });

  it("names the course the preview becomes once that course's first page is persisted", () => {
    const chat = [user('u'), created('c', 'stage-1'), tool('g', 'generate_scene')];
    expect(requestCourse(chat, false)).toEqual({ kind: 'new', ready: [] });
    expect(requestCourse([...chat.slice(0, 2), page('g', 'stage-1')], false)).toEqual({
      kind: 'new',
      ready: ['stage-1'],
    });
  });

  it('lists every course of a series in the order its first page landed', () => {
    const chat = [
      user('u', 'make three lessons'),
      created('c1', 'stage-1'),
      created('c2', 'stage-2'),
      page('p2', 'stage-2'),
      page('p1', 'stage-1'),
      page('p1b', 'stage-1'),
    ];
    expect(requestCourse(chat, false)).toEqual({ kind: 'new', ready: ['stage-2', 'stage-1'] });
  });

  it('attributes a page from the checkpoint the fold stamped on its card', () => {
    let state: WorkbenchFold = createInitialSessionState();
    let id = 0;
    const event = (type: string, data: unknown = {}) => {
      state = foldEvent(state, { id: ++id, ts: id, attempt: 1, type, data });
    };
    event('session_start', { prompt: 'Make a course' });
    event('tool_execution_start', { toolCallId: 'c', toolName: 'create_stage', args: {} });
    event('tool_execution_end', {
      toolCallId: 'c',
      toolName: 'create_stage',
      result: { content: [], details: { stageId: 'stage-1' } },
    });
    // A card whose own arguments name no stage: the checkpoint does.
    event('tool_execution_start', { toolCallId: 'g', toolName: 'generate_scene', args: {} });
    event('checkpoint', { tool: 'generate_scene', stageId: 'stage-1', order: 1, sceneId: 's1' });
    expect(state.chat.find((node) => node.sceneId)?.sceneStageId).toBe('stage-1');
    expect(requestCourse(state.chat, false)).toEqual({ kind: 'new', ready: ['stage-1'] });
  });

  it('keeps the request through the answer to its plan question', () => {
    const chat = [
      user('u', 'make a course'),
      tool('l', 'list_folder_stages'),
      question('q'),
      { ...user('a', 'yes, go'), questionAnswered: true } as ChatNode,
      created('c', 'stage-1'),
      page('p', 'stage-1'),
    ];
    expect(requestCourse(chat, false)).toEqual({ kind: 'new', ready: ['stage-1'] });
  });
});

describe('rule 3: a new conversation shows its preview from the moment it is sent', () => {
  it('is the new course in the making before any tool call or question', () => {
    // Nothing folded yet (queued) and only the opening message: the preview
    // is up, on understanding (see the scheduler).
    expect(requestCourse([], false)).toEqual({ kind: 'new', ready: [] });
    expect(requestCourse([user('u', 'the history of Disney')], false)).toEqual({
      kind: 'new',
      ready: [],
    });
    const thinking: ChatNode = { key: 't', kind: 'thinking', text: 'Planning…' };
    expect(requestCourse([user('u'), thinking], false)).toEqual({ kind: 'new', ready: [] });
  });

  it('stays the course in the making after a request that only chatted', () => {
    // The chat-only request folded away; the next request opens the preview again.
    const chat = [
      user('u1', 'hi'),
      { key: 'a', kind: 'assistant', text: 'Hello! What shall we build?' } as ChatNode,
      user('u2', 'a course on fractions'),
    ];
    expect(requestCourse(chat, false)).toEqual({ kind: 'new', ready: [] });
  });

  it('never applies beside a course, nor before the flag is known', () => {
    expect(requestCourse([user('u', 'hi')], true, 'stage-a')).toEqual({
      kind: 'course',
      courseId: 'stage-a',
    });
    expect(requestCourse([user('u', 'hi')], null)).toEqual({ kind: 'course', courseId: null });
  });
});

describe('rule 4: later requests of a conversation that has its course', () => {
  const first = [user('u1'), created('c', 'stage-1'), page('p', 'stage-1')];

  it('work on that course: no preview', () => {
    expect(
      requestCourse([...first, user('u2', 'add a quiz'), page('q', 'stage-1')], false),
    ).toEqual({ kind: 'course', courseId: 'stage-1' });
    // A follow-up question asked after the page exists starts its own request.
    expect(requestCourse([...first, question('q'), user('a', 'yes')], false)).toEqual({
      kind: 'course',
      courseId: 'stage-1',
    });
    // The pane follows the conversation's latest course, a second one included.
    const second = [...first, user('u2'), created('c2', 'stage-2'), page('p2', 'stage-2')];
    expect(requestCourse([...second, user('u3', 'shorter')], false)).toEqual({
      kind: 'course',
      courseId: 'stage-2',
    });
  });

  it('make a new course through the preview again when they call create_stage', () => {
    const chat = [...first, user('u2', 'now a second course'), created('c2', 'stage-2')];
    expect(requestCourse(chat, false)).toEqual({ kind: 'new', ready: [] });
    expect(requestCourse([...chat, page('p2', 'stage-2')], false)).toEqual({
      kind: 'new',
      ready: ['stage-2'],
    });
  });

  it('keep making the course an earlier request created but wrote no page to', () => {
    // The first run failed after create_stage; "continue" writes its pages.
    const chat = [user('u1'), created('c', 'stage-1'), user('u2', 'continue')];
    expect(requestCourse(chat, false)).toEqual({ kind: 'new', ready: [] });
    expect(requestCourse([...chat, page('p', 'stage-1')], false)).toEqual({
      kind: 'new',
      ready: ['stage-1'],
    });
  });
});

describe('rule 5: the next request starts fresh', () => {
  it('reads only the current request, so a closed preview stays a per-request fact', () => {
    // Request 1 asked and the user never answered with words; request 2 starts.
    const chat = [user('u1'), tool('s', 'web_search'), user('u2', 'something else')];
    expect(requestCourse(chat, false)).toEqual({ kind: 'new', ready: [] });
  });
});

describe('rule 5: a conversation that @-names an existing course', () => {
  const named = (key: string, stageId: string): ChatNode => ({
    key,
    kind: 'user',
    text: 'summarise it',
    courseRefs: [{ kind: 'course', stageId, title: 'A' }],
  });
  it('works on the named course from then on: no preview, every later request included', () => {
    expect(requestCourse([user('u1'), named('u2', 'stage-a')], false)).toEqual({
      kind: 'course',
      courseId: 'stage-a',
    });
    expect(
      requestCourse([named('u1', 'stage-a'), tool('r', 'read_stage'), user('u2')], false),
    ).toEqual({ kind: 'course', courseId: 'stage-a' });
  });
  it('still makes a new course through the preview when a request calls create_stage', () => {
    expect(
      requestCourse([named('u1', 'stage-a'), user('u2'), created('c', 'stage-new')], false),
    ).toEqual({ kind: 'new', ready: [] });
  });
});
