/**
 * The workbench fold (`lib/workbench/session-store.ts` → `foldEvent`): the pure
 * events → view-model mapping that everything in the chat rail renders from.
 *
 * The two properties under test are the ones the SSE resume contract depends
 * on: the UI is a pure function of the applied event prefix, and applying an
 * event twice is a no-op — so a reconnect that overlaps (server replays from
 * `Last-Event-ID`, browser also has it) never double-appends.
 */
import { describe, expect, it } from 'vitest';

import {
  compactReplayEvents,
  useWorkbenchStore,
  COURSE_NODE_KEY,
  foldEvent,
  foldEvents,
  type WorkbenchEvent,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';

let seq = 0;
// Ids are monotonic across the whole file, which is stronger than the fold
// requires (it only compares against `lastEventId` within one fold chain).
function ev(type: string, data: unknown, ts = 1000 + seq): WorkbenchEvent {
  seq += 1;
  return { id: seq, ts, attempt: 1, type, data };
}

const blankFold: WorkbenchFold = {
  status: 'connecting',
  lastEventId: 0,
  error: null,
  courseTitle: null,
  sessionPrompt: null,
  sessionTitle: null,
  skillId: null,
  skillViolations: [],
  plan: [],
  pages: {},
  chat: [],
  libraryRevision: 0,
  stageLinkStageIds: [],
  touchedStageIds: [],
  runCourseStageIds: [],
  generatingOrder: null,
  panelOpen: false,
  panelPinned: false,
  thinkingKey: null,
  assistantKey: null,
  generationOpen: false,
  epoch: 0,
  waitingKey: null,
  waitingArmed: false,
  stageId: null,
};

function foldAll(events: WorkbenchEvent[], initial: WorkbenchFold = blankFold): WorkbenchFold {
  return events.reduce(foldEvent, initial);
}

const assistantMessage = (parts: { type: string; text?: string; thinking?: string }[]) => ({
  role: 'assistant',
  content: parts,
});

/** The chat minus gap-indicator nodes — for assertions about the durable rows. */
const contentOf = (state: WorkbenchFold) => state.chat.filter((n) => n.kind !== 'waiting');

describe('lifecycle events', () => {
  it('session_start opens the run with the user prompt and nothing else', () => {
    const state = foldAll([ev('session_start', { prompt: '给我讲讲光的折射', workerId: 'w1' })]);
    expect(state.status).toBe('running');
    expect(contentOf(state)).toHaveLength(1);
    expect(state.chat[0]).toMatchObject({ kind: 'user', text: '给我讲讲光的折射' });
  });

  it('does not paint the opening message twice when it is already a durable user_message', () => {
    // A session created WITH opening context gets its message persisted as a
    // durable `user_message` by the create route before the runner claims, so
    // the runner's `session_start` must not paint a second bubble — the one
    // true bubble is the durable message, receipt included.
    const named = [{ kind: 'course', stageId: 'stage-a', title: '光的折射' }];
    const state = foldAll([
      ev('user_message', { text: '帮我在这门课程中增加内容', courseRefs: named }),
      ev('session_start', { prompt: '帮我在这门课程中增加内容', workerId: 'w1' }),
    ]);
    expect(state.status).toBe('running');
    const users = contentOf(state).filter((node) => node.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: '帮我在这门课程中增加内容', courseRefs: named });
  });

  it('session_start still paints the opening bubble when no durable message preceded it', () => {
    const state = foldAll([ev('session_start', { prompt: '做一门新课', workerId: 'w1' })]);
    const users = contentOf(state).filter((node) => node.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: '做一门新课' });
  });

  it('session_resumed is one quiet system line', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('session_resumed', { attempt: 2, transcriptMessages: 9 }),
    ]);
    expect(state.status).toBe('running');
    const sys = contentOf(state)[1];
    expect(sys).toMatchObject({ kind: 'system', tone: 'info' });
    expect(sys.text).toContain('中断');
  });

  it('session_interrupted keeps status running and notes the pause', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('session_interrupted', { reason: 'runner shutdown', attempt: 1 }),
    ]);
    expect(state.status).toBe('running');
    expect(contentOf(state)[1]).toMatchObject({ kind: 'system', tone: 'info' });
  });

  it('session_end settles terminal status, tone and dangling streams', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '半截话' }]) }),
      ev('session_end', { status: 'failed', error: 'provider 502' }),
    ]);
    expect(state.status).toBe('failed');
    const assistant = state.chat.find((n) => n.kind === 'assistant');
    expect(assistant?.streaming).toBe(false);
    const end = state.chat[state.chat.length - 1];
    expect(end).toMatchObject({ kind: 'system', tone: 'error' });
    // Summary, next step and raw cause are three fields: the provider's own
    // error text never joins the sentence.
    expect(end.text).toBe('本轮生成失败');
    expect(end.hint).toBe('可以再说一句让它重试');
    expect(end.detail).toBe('provider 502');
    expect(end.text).not.toContain('provider 502');
  });

  it('a failure without a cause carries no technical detail', () => {
    const state = foldAll([ev('session_end', { status: 'failed' })]);
    const end = state.chat[state.chat.length - 1];
    expect(end).toMatchObject({ kind: 'system', tone: 'error', text: '本轮生成失败' });
    expect(end.detail).toBeUndefined();
  });

  it('session_end succeeded leaves no divider; the next user bubble is the break', () => {
    const state = foldAll([ev('session_end', { status: 'succeeded' })]);
    expect(state.status).toBe('succeeded');
    expect(state.chat.filter((n) => n.kind === 'boundary')).toHaveLength(0);
  });

  it('session_end cancelled is a quiet caption, not a ruled section', () => {
    const state = foldAll([ev('session_end', { status: 'cancelled' })]);
    expect(state.status).toBe('cancelled');
    expect(state.chat[0]).toMatchObject({ kind: 'boundary', text: '本轮生成已停止' });
  });

  it('a follow-up session_resumed restarts the run without a chat row', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('session_end', { status: 'succeeded' }),
      ev('user_message', { text: '第二页加个练习', delivery: 'queued' }),
      ev('session_resumed', { attempt: 1, reason: 'follow_up', transcriptMessages: 12 }),
    ]);
    expect(state.status).toBe('running');
    // user bubble then follow-up bubble. Success adds no divider; the resume
    // itself is not a row (the waiting node is the gap indicator).
    expect(contentOf(state).map((n) => n.kind)).toEqual(['user', 'user']);
  });

  it('stage_link (and legacy course_link) records each stage only on first appearance', () => {
    let state = foldAll([ev('session_start', { prompt: 'p' })]);
    expect(state.stageLinkStageIds).toEqual([]);
    state = foldEvent(
      state,
      ev('course_link', {
        stageId: 'stage-day-2',
        title: 'Day 2 — Loops',
        url: '/classroom/stage-day-2',
      }),
    );
    expect(state.stageLinkStageIds).toEqual(['stage-day-2']);
    state = foldEvent(
      state,
      ev('course_link', {
        stageId: 'stage-day-2',
        title: 'Day 2 again',
        url: '/classroom/stage-day-2',
      }),
    );
    expect(state.stageLinkStageIds).toEqual(['stage-day-2']);
  });

  it('a malformed stage_link frame is ignored', () => {
    let state = foldAll([ev('course_link', { stageId: 'stage-day-2', title: 'Day 2' })]);
    state = foldEvent(state, ev('course_link', { title: 'no id here' }));
    expect(state.stageLinkStageIds).toEqual(['stage-day-2']);
  });

  it('accepts the legacy course_link name and the new stage_link name identically', () => {
    // DURABLE COMPAT: pre-rename sessions wrote `course_link` into their event
    // logs. A cold replay of such a transcript must fold those frames exactly
    // like the new `stage_link` frames, and mixing both names must keep the
    // first-seen ordering and de-dup intact.
    const events: WorkbenchEvent[] = [
      ev('session_start', { prompt: 'p' }),
      ev('course_link', { stageId: 'stage-a', title: 'A', url: '/classroom/stage-a' }),
      ev('stage_link', { stageId: 'stage-b', title: 'B', url: '/classroom/stage-b' }),
      ev('course_link', { stageId: 'stage-a', title: 'A again', url: '/classroom/stage-a' }),
      ev('stage_link', { stageId: 'stage-c', title: 'C', url: '/classroom/stage-c' }),
    ];
    const folded = foldAll(events);
    expect(folded.stageLinkStageIds).toEqual(['stage-a', 'stage-b', 'stage-c']);
    // The new name alone folds identically to the old name alone.
    const newOnly = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('stage_link', { stageId: 'stage-x', title: 'X', url: '/classroom/stage-x' }),
    ]);
    const oldOnly = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('course_link', { stageId: 'stage-x', title: 'X', url: '/classroom/stage-x' }),
    ]);
    expect(newOnly.stageLinkStageIds).toEqual(oldOnly.stageLinkStageIds);
  });

  it('stage_link folds identically on a cold replay (replay consistency)', () => {
    const events: WorkbenchEvent[] = [
      ev('session_start', { prompt: 'p' }),
      ev('course_link', { stageId: 'stage-a', title: 'A', url: '/classroom/stage-a' }),
      ev('checkpoint', { tool: 'generate_scene', sceneId: 's1', order: 1, title: 'Page 1' }),
      ev('course_link', { stageId: 'stage-b', title: 'B', url: '/classroom/stage-b' }),
    ];
    const live = foldAll(events);
    // A replayed log (fresh fold) rebuilds the same stage identity, and
    // folding an overlapping prefix twice is a no-op — the fold stays a pure
    // function of the applied event prefix.
    const replayed = foldAll(events);
    const doubled = foldAll([...events, ...events]);
    expect(replayed).toEqual(live);
    expect(doubled).toEqual(live);
    expect(live.stageLinkStageIds).toEqual(['stage-a', 'stage-b']);
  });

  it('library_changed counts the run’s stage/folder writes and nothing else', () => {
    // The counter is the left rail's staleness signal: the workspace refetches
    // its course + folder list on an increase (the same sink the first committed
    // page uses), so an agent-created course or folder appears without a reload.
    let state = foldAll([ev('session_start', { prompt: 'p' })]);
    expect(state.libraryRevision).toBe(0);
    state = foldEvent(
      state,
      ev('library_changed', { change: 'stage_created', stageId: 'stage-day-1', title: 'Day 1' }),
    );
    expect(state.libraryRevision).toBe(1);
    state = foldEvent(
      state,
      ev('library_changed', { change: 'folder_created', folderId: 'f1', name: '7 天学 Python' }),
    );
    state = foldEvent(
      state,
      ev('library_changed', { change: 'stage_moved', stageId: 'stage-day-1', folderId: 'f1' }),
    );
    expect(state.libraryRevision).toBe(3);
    // A library write is not a conversation event: no row, no system line. The
    // agent's own sentence is what tells the user a folder was made.
    expect(contentOf(state).map((n) => n.kind)).toEqual(['user']);
    // And it says nothing about a stage link; that is a separate event.
    expect(state.stageId).toBeNull();
  });

  it('remembers WHICH stages the run created, in creation order (one tab each)', () => {
    // The right pane opens one tab per created classroom, so unlike the counter
    // this list has to say which stage and in what order.
    let state = foldAll([ev('session_start', { prompt: 'p' })]);
    expect(state.stageLinkStageIds).toEqual([]);
    state = foldEvent(
      state,
      ev('library_changed', { change: 'stage_created', stageId: 'stage-day-1', title: 'Day 1' }),
    );
    state = foldEvent(
      state,
      ev('library_changed', { change: 'folder_created', folderId: 'f1', name: '7 天学 Python' }),
    );
    state = foldEvent(
      state,
      ev('library_changed', { change: 'stage_created', stageId: 'stage-day-2', title: 'Day 2' }),
    );
    state = foldEvent(
      state,
      ev('library_changed', { change: 'stage_moved', stageId: 'stage-day-2', folderId: 'f1' }),
    );
    state = foldEvent(state, ev('course_link', { stageId: 'stage-day-1', title: 'Day 1' }));
    state = foldEvent(state, ev('course_link', { stageId: 'stage-day-2', title: 'Day 2' }));
    expect(state.stageLinkStageIds).toEqual(['stage-day-1', 'stage-day-2']);
  });

  it('never lists one created stage twice, and ignores a stage_created with no id', () => {
    // Two tabs for one classroom is the failure this guards: the runner emits
    // stage_created once per mint, but a retried create_stage and an overlapping
    // reconnect are both shapes where the same id could arrive again.
    let state = foldAll([
      ev('library_changed', { change: 'stage_created', stageId: 'st1', title: 'Day 1' }),
      ev('library_changed', { change: 'stage_created', stageId: 'st1', title: 'Day 1' }),
    ]);
    state = foldEvent(state, ev('course_link', { stageId: 'st1', title: 'Day 1' }));
    expect(state.stageLinkStageIds).toEqual(['st1']);
    state = foldEvent(state, ev('library_changed', { change: 'stage_created', title: 'no id' }));
    state = foldEvent(
      state,
      ev('library_changed', { change: 'stage_created', stageId: '   ', title: 'blank id' }),
    );
    expect(state.stageLinkStageIds).toEqual(['st1']);
    // The write still counted — the tree refetches either way.
    expect(state.libraryRevision).toBe(4);
  });

  it('rebuilds the created-stage order on a cold replay (replay consistency)', () => {
    // A historical series run restores every classroom it built, in the order it
    // built them, which is what the tab strip is restored from.
    const events: WorkbenchEvent[] = [
      ev('session_start', { prompt: 'p' }),
      ev('library_changed', { change: 'folder_created', folderId: 'f1', name: 'S' }),
      ev('library_changed', { change: 'stage_created', stageId: 'st1', title: 'Day 1' }),
      ev('course_link', { stageId: 'st1', title: 'Day 1' }),
      ev('checkpoint', { tool: 'generate_scene', sceneId: 's1', order: 1 }),
      ev('library_changed', { change: 'stage_created', stageId: 'st2', title: 'Day 2' }),
      ev('course_link', { stageId: 'st2', title: 'Day 2' }),
    ];
    const live = foldAll(events);
    expect(live.stageLinkStageIds).toEqual(['st1', 'st2']);
    expect(foldAll(events)).toEqual(live);
    expect(foldAll([...events, ...events])).toEqual(live);
    expect(foldEvents(blankFold, compactReplayEvents(events))).toEqual(live);
  });

  it('a page checkpoint does NOT count as a library write', () => {
    // A page landing inside a course the tree already lists is not a library
    // change; conflating them would refetch the whole list per page.
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('checkpoint', { tool: 'generate_scene', sceneId: 's1', order: 1, title: 'Page 1' }),
    ]);
    expect(state.libraryRevision).toBe(0);
  });

  it('library_changed folds identically on a cold replay, and re-applying is a no-op', () => {
    const events: WorkbenchEvent[] = [
      ev('session_start', { prompt: 'p' }),
      ev('library_changed', { change: 'folder_created', folderId: 'f1', name: 'S' }),
      ev('library_changed', { change: 'stage_created', stageId: 'st1', title: 'Day 1' }),
      ev('checkpoint', { tool: 'generate_scene', sceneId: 's1', order: 1 }),
      ev('library_changed', { change: 'stage_moved', stageId: 'st1', folderId: 'f1' }),
    ];
    const live = foldAll(events);
    expect(live.libraryRevision).toBe(3);
    // Same prefix in, same count out — the counter cannot drift on replay, which
    // is why it is a count of durable events rather than a "refresh pending" flag.
    expect(foldAll(events)).toEqual(live);
    expect(foldAll([...events, ...events])).toEqual(live);
    expect(foldEvents(blankFold, compactReplayEvents(events))).toEqual(live);
  });
});

describe('assistant text and thinking', () => {
  it('message_update streams one node in place; message_end finalizes it', () => {
    let state = foldAll([ev('session_start', { prompt: 'p' })]);
    state = foldEvent(
      state,
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '你好' }]) }),
    );
    state = foldEvent(
      state,
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '你好，世界' }]) }),
    );
    const assistants = state.chat.filter((n) => n.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: '你好，世界', streaming: true });

    state = foldEvent(
      state,
      ev('message_end', { message: assistantMessage([{ type: 'text', text: '你好，世界。' }]) }),
    );
    const final = state.chat.filter((n) => n.kind === 'assistant');
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ text: '你好，世界。', streaming: false });
  });

  it('late message_update after message_end and session_end does not duplicate the reply', () => {
    const body = assistantMessage([
      { type: 'thinking', thinking: 'For safety, let me run a quick sanity check.' },
      { type: 'text', text: 'HTML 全部读到了，UI 问题定位清楚了' },
    ]);
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_update', { message: body }),
      ev('message_end', { message: body }),
      ev('message_update', { message: body }),
      ev('session_end', { status: 'succeeded' }),
      ev('message_update', { message: body }),
    ]);
    const assistants = state.chat.filter((n) => n.kind === 'assistant');
    const thinking = state.chat.filter((n) => n.kind === 'thinking');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toContain('HTML 全部读到了');
    expect(thinking).toHaveLength(1);
    expect(state.chat.filter((n) => n.kind === 'boundary')).toHaveLength(0);
  });

  it('a streaming assistant node with empty final text is dropped', () => {
    const state = foldAll([
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '' }]) }),
      ev('message_end', { message: assistantMessage([{ type: 'text', text: '' }]) }),
    ]);
    expect(state.chat.filter((n) => n.kind === 'assistant')).toHaveLength(0);
  });

  it('does not leave an empty thinking bar when the first content is plain text', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '你好' }]) }),
    ]);
    expect(state.chat.filter((n) => n.kind === 'thinking')).toHaveLength(0);
    expect(state.chat.filter((n) => n.kind === 'waiting')).toHaveLength(0);
  });

  it('upgrades the gap bar in place and keeps it after the model stops thinking', () => {
    let state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_update', {
        message: assistantMessage([{ type: 'thinking', thinking: '先想清楚结构' }]),
      }),
    ]);
    const during = state.chat.filter((n) => n.kind === 'thinking');
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ text: '先想清楚结构', streaming: true });
    expect(state.waitingKey).toBeNull();

    state = foldEvent(
      state,
      ev('tool_execution_start', { toolCallId: 'tc1', toolName: 'list_scenes', args: {} }),
    );
    const after = state.chat.filter((n) => n.kind === 'thinking');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      key: during[0].key,
      text: '先想清楚结构',
      streaming: false,
    });
    expect(after[0].endedAt).toBeDefined();
  });

  it('thinking folds into its own node and closes when text starts', () => {
    const state = foldAll([
      ev('message_start', { message: assistantMessage([]) }),
      ev('message_update', {
        message: assistantMessage([{ type: 'thinking', thinking: '先想第一段' }]),
      }),
      ev('message_update', {
        message: assistantMessage([
          { type: 'thinking', thinking: '先想第一段，再想第二段' },
          { type: 'text', text: '答案' },
        ]),
      }),
      ev('message_end', {
        message: assistantMessage([
          { type: 'thinking', thinking: '先想第一段，再想第二段' },
          { type: 'text', text: '答案。' },
        ]),
      }),
    ]);
    const thinking = state.chat.filter((n) => n.kind === 'thinking');
    const assistants = state.chat.filter((n) => n.kind === 'assistant');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ text: '先想第一段，再想第二段', streaming: false });
    expect(thinking[0].endedAt).toBeDefined();
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: '答案。', streaming: false });
    expect(state.thinkingKey).toBeNull();
    expect(state.assistantKey).toBeNull();
    expect(state.generationOpen).toBe(false);
  });

  it('keeps assistant text before a later tool when late updates arrive after message_end', () => {
    const body = assistantMessage([
      { type: 'thinking', thinking: 'For safety, let me run a quick sanity check.' },
      { type: 'text', text: 'HTML 全部读到了，UI 问题定位清楚了' },
    ]);
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_update', { message: body }),
      ev('message_end', { message: body }),
      ev('message_update', { message: body }),
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'edit_widget',
        args: { op: 'edit_html' },
      }),
      ev('tool_execution_end', {
        toolCallId: 'tc1',
        toolName: 'edit_widget',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
      }),
      ev('message_update', { message: body }),
    ]);
    expect(state.chat.filter((n) => n.kind !== 'waiting').map((n) => n.kind)).toEqual([
      'user',
      'thinking',
      'assistant',
      'tool',
    ]);
    expect(state.chat.filter((n) => n.kind === 'assistant')).toHaveLength(1);
  });

  it('a second message gets a second thinking node, not an update of the first', () => {
    const first = [
      ev('message_start', { message: assistantMessage([]) }),
      ev('message_update', {
        message: assistantMessage([{ type: 'thinking', thinking: '第一段推理' }]),
      }),
      ev('message_end', {
        message: assistantMessage([{ type: 'thinking', thinking: '第一段推理' }]),
      }),
    ];
    const second = [
      ev('message_start', { message: assistantMessage([]) }),
      ev('message_update', {
        message: assistantMessage([{ type: 'thinking', thinking: '第二段推理' }]),
      }),
      ev('message_end', {
        message: assistantMessage([{ type: 'thinking', thinking: '第二段推理' }]),
      }),
    ];
    const state = foldAll([...first, ...second]);
    const thinking = state.chat.filter((n) => n.kind === 'thinking');
    expect(thinking).toHaveLength(2);
    expect(thinking[0].text).toBe('第一段推理');
    expect(thinking[1].text).toBe('第二段推理');
  });
});

describe('tool calls', () => {
  const start = () =>
    ev('tool_execution_start', {
      toolCallId: 'tc1',
      toolName: 'generate_scene',
      args: { order: 2 },
    });

  it('start folds a running card and marks the page being written', () => {
    const state = foldAll([start()]);
    expect(state.generatingOrder).toBe(2);
    expect(state.chat[0]).toMatchObject({
      kind: 'tool',
      toolName: 'generate_scene',
      toolState: 'running',
      toolArgs: { order: 2 },
    });
  });

  it('trace lands on the running card as a ring of lines, kept after the call ends', () => {
    let state = foldAll([
      start(),
      ev('trace', { message: 'page 2: calling LLM…' }),
      ev('trace', { message: 'page 2: generating actions' }),
    ]);
    expect(state.chat[0].toolTraces).toEqual([
      'page 2: calling LLM…',
      'page 2: generating actions',
    ]);
    state = foldEvent(
      state,
      ev('tool_execution_end', {
        toolCallId: 'tc1',
        toolName: 'generate_scene',
        result: {
          content: [{ type: 'text', text: 'persisted' }],
          details: { order: 2, title: '折射' },
        },
        isError: false,
      }),
    );
    expect(state.chat[0]).toMatchObject({
      toolState: 'done',
      toolDetails: { order: 2, title: '折射' },
      toolResultText: 'persisted',
    });
    // The ring survives completion — it leaves the collapsed row and stays
    // behind the disclosure.
    expect(state.chat[0].toolTraces).toHaveLength(2);
    expect(state.generatingOrder).toBeNull();
  });

  it('a trace with no call in flight folds to nothing', () => {
    const state = foldAll([ev('trace', { message: 'stray' })]);
    expect(state.chat).toHaveLength(0);
  });

  it('isError marks the card failed', () => {
    const state = foldAll([
      start(),
      ev('tool_execution_end', {
        toolCallId: 'tc1',
        toolName: 'generate_scene',
        result: { content: [{ type: 'text', text: 'gateway 524' }] },
        isError: true,
      }),
    ]);
    expect(state.chat[0].toolState).toBe('failed');
  });
});

describe('checkpoints and the panel', () => {
  it.each(['generate_roster', 'set_roster'])(
    '%s checkpoint leaves freshness to the manifest path',
    (tool) => {
      const state = foldAll([ev('checkpoint', { tool, detail: '课堂阵容已更新' })]);
      expect('courseRevision' in state).toBe(false);
    },
  );

  it('an outline checkpoint folds the plan without a session freshness counter', () => {
    const state = foldAll([
      ev('checkpoint', {
        tool: 'generate_outline',
        outline: [
          { order: 1, title: '引入', type: 'slide' },
          { order: 2, title: '实验', type: 'interactive' },
        ],
        courseTitle: '光的折射',
        skill: 'k12',
        skillViolations: [],
      }),
    ]);
    expect(state.plan).toHaveLength(2);
    expect(state.courseTitle).toBe('光的折射');
    expect(state.skillId).toBe('k12');
    expect(state.panelOpen).toBe(false);
  });

  it('the first page checkpoint slides the panel out — unless the user pinned it', () => {
    const page = () =>
      ev('checkpoint', { tool: 'generate_scene', order: 1, title: '引入', sceneId: 's1' });
    const auto = foldAll([page()]);
    expect(auto.panelOpen).toBe(true);
    expect(auto.pages[1]).toMatchObject({ order: 1, sceneId: 's1' });

    const pinned = foldAll([page()], { ...blankFold, panelPinned: true, panelOpen: false });
    expect(pinned.panelOpen).toBe(false);
  });

  it('a page checkpoint attributes the scene to the running tool card', () => {
    const state = foldAll([
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'generate_scene',
        args: { order: 1 },
      }),
      ev('checkpoint', { tool: 'generate_scene', order: 1, sceneId: 'scene-1' }),
    ]);
    expect(state.chat[0]).toMatchObject({ kind: 'tool', sceneId: 'scene-1' });
  });
});

describe('the session-level freshness gates are gone (#1960 Part 2)', () => {
  it('a checkpoint keeps progress plus strip metadata, but no freshness counter', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-existing', sceneId: 's1', order: 1 }),
    ]);
    // touchedStageIds remains append-only metadata for the session course strip;
    // it is no longer an unlock. Canvas freshness is the DB triggers' job now.
    expect(state.touchedStageIds).toEqual(['stage-existing']);
    expect('courseRevision' in state).toBe(false);
    expect(state.pages[1]).toMatchObject({ order: 1, sceneId: 's1' });
  });

  it('writer start keeps page progress plus early strip attribution', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'generate_scene',
        args: { stageId: 'stage-secondary', order: 3 },
      }),
    ]);
    expect(state.generatingOrder).toBe(3);
    expect(state.touchedStageIds).toEqual(['stage-secondary']);
  });

  it('deduplicates touched courses in first-seen order across writer starts and checkpoints', () => {
    const events: WorkbenchEvent[] = [
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'patch_stage',
        args: { stageId: 'stage-a' },
      }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-b' }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a' }),
    ];
    const live = foldAll(events);
    expect(live.touchedStageIds).toEqual(['stage-a', 'stage-b']);
    expect(foldAll(events)).toEqual(live);
    expect(foldAll([...events, ...events])).toEqual(live);
    expect(foldEvents(blankFold, compactReplayEvents(events))).toEqual(live);
  });

  it('reader tools do not enter touchedStageIds, while a writer still does', () => {
    const state = foldAll([
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'read_stage',
        args: { stageId: 'stage-pane' },
      }),
      ev('tool_execution_start', {
        toolCallId: 'tc2',
        toolName: 'grep_stage',
        args: { stageId: 'stage-pane' },
      }),
      ev('tool_execution_start', {
        toolCallId: 'tc3',
        toolName: 'rename_stage',
        args: { stageId: 'stage-written' },
      }),
    ]);
    expect(state.touchedStageIds).toEqual(['stage-written']);
  });
});

/**
 * The per-exchange classroom cards.
 *
 * The rule the fold implements: at `agent_end`, the classrooms THAT EXCHANGE
 * produced or was pointed at become one row at the tail of the answer.
 * De-duplicated inside an exchange, deliberately NOT across them.
 *
 * `agent_end` AND NOT `turn_end` is the whole point of this block. pi's `turn` is
 * one assistant message plus its tool calls, so an answer that writes ten pages
 * is ten turns against ONE classroom — flushing per turn ended that answer with
 * ten identical cards, which is not what "one round" meant. An exchange is one question
 * and its answer: `agent_start` … `agent_end`.
 *
 * What counts as an appearance (and why a reader tool does not) lives in
 * `lib/workbench/run-courses`; this file pins WHEN and WHERE the row lands, which
 * is the half a replay can get wrong.
 */
describe('an answer ends with the classrooms it touched', () => {
  /** The card rows, in timeline order. */
  const cardsOf = (state: WorkbenchFold) =>
    state.chat.filter((n) => n.kind === 'course').map((n) => n.stageIds ?? []);
  /** Every row's kind, so a card's POSITION in the answer can be asserted. */
  const shapeOf = (state: WorkbenchFold) => contentOf(state).map((n) => n.kind);

  it('flushes at agent_end, after the answer’s own rows', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('agent_start', {}),
      ev('turn_start', {}),
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'patch_stage',
        args: { stageId: 'stage-a' },
      }),
      ev('tool_execution_end', { toolCallId: 'tc1', result: {} }),
      ev('turn_end', {}),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([['stage-a']]);
    // The card is the LAST thing in the answer — not before the tool card that
    // earned it.
    expect(shapeOf(state)).toEqual(['user', 'tool', 'course']);
  });

  /**
   * THE REASON THE FLUSH POINT MOVED. Ten pages is ten pi turns against one
   * classroom; per-turn flushing painted ten identical cards.
   */
  it('paints ONE card for a ten-turn answer against one classroom', () => {
    const events: WorkbenchEvent[] = [
      ev('session_start', { prompt: '写十页' }),
      ev('agent_start', {}),
    ];
    for (let order = 1; order <= 10; order += 1) {
      events.push(
        ev('turn_start', {}),
        ev('tool_execution_start', {
          toolCallId: `tc${order}`,
          toolName: 'generate_scene',
          args: { stageId: 'stage-a', order },
        }),
        ev('checkpoint', {
          tool: 'generate_scene',
          stageId: 'stage-a',
          sceneId: `s${order}`,
          order,
        }),
        ev('turn_end', {}),
      );
    }
    events.push(ev('agent_end', { messages: [] }));
    const state = foldAll(events);
    expect(cardsOf(state)).toEqual([['stage-a']]);
    expect(state.chat.filter((n) => n.kind === 'course')).toHaveLength(1);
  });

  it('paints nothing at a turn boundary — only the answer’s end flushes', () => {
    const mid = foldAll([
      ev('agent_start', {}),
      ev('turn_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's1', order: 1 }),
      ev('turn_end', {}),
      ev('turn_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-b', sceneId: 's2', order: 2 }),
      ev('turn_end', {}),
    ]);
    expect(mid.chat.filter((n) => n.kind === 'course')).toEqual([]);
    // …and the buffer is holding both, which is the state a replay must rebuild.
    expect(mid.runCourseStageIds).toEqual(['stage-a', 'stage-b']);
  });

  it('de-duplicates within one answer, whatever named the classroom', () => {
    const state = foldAll([
      ev('agent_start', {}),
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'patch_stage',
        args: { stageId: 'stage-a' },
      }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's1', order: 1 }),
      ev('stage_link', { stageId: 'stage-a', title: '光的折射', url: '/classroom/stage-a' }),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([['stage-a']]);
    expect(state.runCourseStageIds).toEqual([]);
  });

  it('does NOT de-duplicate across answers — a second question earns a second card', () => {
    const state = foldAll([
      ev('agent_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's1', order: 1 }),
      ev('agent_end', { messages: [] }),
      ev('user_message', { text: '再改一次', delivery: 'queued' }),
      ev('agent_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's2', order: 2 }),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([['stage-a'], ['stage-a']]);
    // Two rows, two keys: the row is keyed on the frame that flushed it.
    const keys = state.chat.filter((n) => n.kind === 'course').map((n) => n.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('keeps several classrooms of one answer in first-seen order', () => {
    const state = foldAll([
      ev('agent_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-b', sceneId: 's1', order: 1 }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's2', order: 2 }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-b', sceneId: 's3', order: 3 }),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([['stage-b', 'stage-a']]);
  });

  it('counts an `@` mention, and flushes it at the end of the answering exchange', () => {
    const state = foldAll([
      ev('user_message', {
        text: '把这节课改一下',
        delivery: 'queued',
        courseRefs: [{ kind: 'course', stageId: 'stage-named', title: '光的折射' }],
      }),
      ev('agent_start', {}),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([['stage-named']]);
    // The mention arrives BEFORE the run opens (the control plane writes it), so
    // the buffer has to span that gap — this is the assertion that pins it.
    expect(shapeOf(state)).toEqual(['user', 'course']);
  });

  it('mixes a mention and a writer tool into one answer’s set, mention first', () => {
    const state = foldAll([
      ev('user_message', {
        text: '照这个改',
        delivery: 'queued',
        courseRefs: [{ kind: 'course', stageId: 'stage-named', title: '参考课' }],
      }),
      ev('agent_start', {}),
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'generate_scene',
        args: { stageId: 'stage-written', order: 1 },
      }),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([['stage-named', 'stage-written']]);
  });

  it('carries a mid-answer steer into the SAME card set', () => {
    // A steered message is injected between steps of a live run, so it belongs to
    // the answer already in flight rather than opening a new one.
    const state = foldAll([
      ev('agent_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's1', order: 1 }),
      ev('user_message', {
        text: '顺便也看看这门',
        delivery: 'steer',
        courseRefs: [{ kind: 'course', stageId: 'stage-steered', title: '另一门' }],
      }),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([['stage-a', 'stage-steered']]);
  });

  it('never paints a card for a classroom the agent only READ', () => {
    const state = foldAll([
      ev('agent_start', {}),
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'read_stage',
        args: { stageId: 'stage-looked-at' },
      }),
      ev('tool_execution_start', {
        toolCallId: 'tc2',
        toolName: 'grep_stage',
        args: { stageId: 'stage-looked-at' },
      }),
      ev('agent_end', { messages: [] }),
    ]);
    expect(state.chat.filter((n) => n.kind === 'course')).toEqual([]);
    expect(state.runCourseStageIds).toEqual([]);
  });

  it('an answer that touched nothing ends with no row at all', () => {
    const state = foldAll([ev('agent_start', {}), ev('agent_end', { messages: [] })]);
    expect(contentOf(state)).toEqual([]);
  });

  it('a run that dies before agent_end paints no card', () => {
    // The buffer keeps the sighting (the prefix says it happened), but nothing
    // was produced to point at, and the user's own bubble already carries the
    // `@` pill.
    const state = foldAll([
      ev('user_message', {
        text: '看看这个',
        delivery: 'queued',
        courseRefs: [{ kind: 'course', stageId: 'stage-named', title: '参考课' }],
      }),
      ev('agent_start', {}),
      ev('session_end', { status: 'failed', error: 'boom' }),
    ]);
    expect(state.chat.filter((n) => n.kind === 'course')).toEqual([]);
    expect(state.runCourseStageIds).toEqual(['stage-named']);
  });

  it('carries an interrupted answer’s classrooms to the resumed run’s flush', () => {
    // A worker dying mid-answer emits no `agent_end`. The buffer survives the
    // interruption, so the answer that another instance finishes still ends with
    // ONE card set covering the whole of it.
    const state = foldAll([
      ev('agent_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's1', order: 1 }),
      ev('session_interrupted', { reason: 'shutdown' }),
      ev('session_resumed', { reason: 'takeover', repairedToolCalls: [] }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-b', sceneId: 's2', order: 2 }),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([['stage-a', 'stage-b']]);
  });

  it('flushes an interrupted answer’s classrooms when the repaired run ends cancelled', () => {
    // A server restart parks the run (`session_interrupted`), the next instance
    // resumes it (`session_resumed`), and the stop lands before pi closes the
    // answer (`session_end` cancelled) — so no `agent_end` ever drains the
    // buffer. The pending sightings are the classrooms this answer produced,
    // and the terminal card must still carry them: the card the timeline ends
    // with is the course the session knows, not the stopped caption alone.
    const state = foldAll([
      ev('session_start', { prompt: '写一门课' }),
      ev('agent_start', {}),
      ev('checkpoint', {
        tool: 'patch_stage',
        stageId: 'stage-a',
        sceneId: 's1',
        order: 1,
        outline: [],
        courseTitle: '光的折射',
      }),
      ev('session_interrupted', { reason: 'lease lost' }),
      ev('session_resumed', { reason: 'crash', repairedToolCalls: [] }),
      ev('session_end', { status: 'cancelled' }),
    ]);
    const courses = state.chat.filter((n) => n.kind === 'course');
    expect(courses).toHaveLength(1);
    // The card carries the known stage ref — the name/link the timeline ends on.
    expect(courses[0]?.stageIds).toEqual(['stage-a']);
    // It sits at the tail, directly above the stopped caption.
    const kinds = contentOf(state).map((n) => n.kind);
    expect(kinds.slice(-2)).toEqual(['course', 'boundary']);
    // The buffer drained into the card, and the fold still knows the course
    // name the card renders from.
    expect(state.runCourseStageIds).toEqual([]);
    expect(state.courseTitle).toBe('光的折射');
  });

  it('keeps the legacy single unbound row for checkpoints without a stageId', () => {
    // A v1 transcript's page checkpoint carried no stage id at all — and may
    // predate the pi frames the per-exchange rule flushes on, so this row is
    // appended at the checkpoint itself, exactly as it always was.
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('checkpoint', { tool: 'generate_scene', sceneId: 's1', order: 1 }),
      ev('checkpoint', { tool: 'generate_scene', sceneId: 's2', order: 2 }),
    ]);
    const courses = state.chat.filter((n) => n.kind === 'course');
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({ key: COURSE_NODE_KEY, kind: 'course', text: '' });
    expect(courses[0]?.stageIds).toBeUndefined();
  });

  it('keeps the legacy row and the answer’s cards apart', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('agent_start', {}),
      ev('checkpoint', { tool: 'generate_scene', sceneId: 'legacy', order: 1 }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's2', order: 2 }),
      ev('agent_end', { messages: [] }),
    ]);
    expect(cardsOf(state)).toEqual([[], ['stage-a']]);
  });

  /**
   * REPLAY STABILITY — the whole reason this rule lives in the fold.
   *
   * The buffer, the flush point and the row's key are all functions of the
   * applied prefix, so a cold replay must rebuild every exchange's card set, in
   * order, at the same position — and re-applying a frame must add nothing.
   * `compactReplayEvents` is included because a real replay goes through it.
   */
  it('rebuilds every answer’s card set identically on a cold replay', () => {
    const events: WorkbenchEvent[] = [
      ev('session_start', { prompt: '写两节课' }),
      ev('agent_start', {}),
      ev('turn_start', {}),
      ev('tool_execution_start', {
        toolCallId: 'tc1',
        toolName: 'patch_stage',
        args: { stageId: 'stage-a' },
      }),
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '在改' }]) }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's1', order: 1 }),
      ev('turn_end', {}),
      // A second pi turn INSIDE the same answer: it must not add a card of its own.
      ev('turn_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's2', order: 2 }),
      ev('turn_end', {}),
      ev('agent_end', { messages: [] }),
      ev('user_message', {
        text: '再加一节',
        delivery: 'queued',
        courseRefs: [{ kind: 'course', stageId: 'stage-named', title: '参考课' }],
      }),
      ev('agent_start', {}),
      ev('tool_execution_start', {
        toolCallId: 'tc2',
        toolName: 'read_stage',
        args: { stageId: 'stage-only-read' },
      }),
      ev('stage_link', { stageId: 'stage-b', title: '新课', url: '/classroom/stage-b' }),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's3', order: 3 }),
      ev('agent_end', { messages: [] }),
    ];
    const live = foldAll(events);
    // The shape under test, spelled out: answer 1 ends with stage-a ONCE across
    // its two turns; answer 2 ends with the mention, the linked stage and stage-a
    // AGAIN (a new exchange), and never the classroom that was only read.
    expect(cardsOf(live)).toEqual([['stage-a'], ['stage-named', 'stage-b', 'stage-a']]);
    const positions = (state: WorkbenchFold) =>
      contentOf(state).map((n, index) => `${index}:${n.kind}`);
    expect(foldAll(events)).toEqual(live);
    expect(positions(foldAll(events))).toEqual(positions(live));
    // Re-applying the whole log is a no-op: no second set of cards.
    expect(foldAll([...events, ...events])).toEqual(live);
    expect(foldEvents(blankFold, compactReplayEvents(events))).toEqual(live);
    // …and an overlapping resume (the server replays from Last-Event-ID while
    // the browser already has the tail) does not duplicate a flush either.
    expect(foldEvents(live, events.slice(-4))).toEqual(live);
  });

  it('flushes at the same frame however the prefix is cut', () => {
    const events: WorkbenchEvent[] = [
      ev('agent_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-a', sceneId: 's1', order: 1 }),
      ev('agent_end', { messages: [] }),
      ev('agent_start', {}),
      ev('checkpoint', { tool: 'patch_stage', stageId: 'stage-b', sceneId: 's2', order: 2 }),
      ev('agent_end', { messages: [] }),
    ];
    // Every prefix folded from scratch equals the same prefix folded
    // incrementally — i.e. there is no state outside the fold deciding where a
    // card goes.
    for (let cut = 1; cut <= events.length; cut += 1) {
      const prefix = events.slice(0, cut);
      expect(foldAll(prefix), `prefix of ${cut}`).toEqual(prefix.reduce(foldEvent, blankFold));
    }
  });
});

describe('consent_required', () => {
  it('does not paint a consent card — write arbitration is off', () => {
    const state = foldAll([
      ev('consent_required', {
        sceneId: 'scene-1',
        order: 2,
        title: '折射',
        reason: 'dirty',
      }),
    ]);
    expect(state.chat).toEqual([]);
  });
});

describe('unknown event types are silently ignored', () => {
  // The fold's `default` case must never throw or paint for an event type the
  // UI branch does not know yet — an old frontend receiving a NEW server event
  // keeps working as if the event had never been sent. Only the seq watermark
  // advances.
  it('an unknown event leaves the projection untouched', () => {
    const before = foldAll([ev('session_start', { prompt: 'p' })]);
    const state = foldEvent(before, ev('some_future_event', { whatever: true }));
    // Identical projection — only the durable seq watermark moved.
    expect({ ...state, lastEventId: 0 }).toEqual({ ...before, lastEventId: 0 });
    expect(state.lastEventId).toBe(before.lastEventId + 1);
  });
});

describe('user_question (the ask_user card)', () => {
  const question = (data: Record<string, unknown>) => ev('user_question', data);

  it('folds the envelope into a question node and closes the gap indicator', () => {
    // ask_user is terminal for the run, so the three dots must not sit under
    // the card waiting for an answer the agent is not going to write.
    const state = foldAll([
      ev('session_start', { prompt: '做一门课' }),
      question({
        question: '先做哪一版大纲？',
        options: [
          { id: 'plan-a', label: '按章节' },
          { id: 'plan-b', label: '按项目' },
        ],
      }),
    ]);
    expect(state.waitingKey).toBeNull();
    expect(state.chat.filter((n) => n.kind === 'waiting')).toHaveLength(0);
    const card = contentOf(state).at(-1);
    expect(card).toMatchObject({
      kind: 'question',
      text: '先做哪一版大纲？',
      questionOptions: [
        { id: 'plan-a', label: '按章节' },
        { id: 'plan-b', label: '按项目' },
      ],
    });
    expect(card?.questionAnswered).toBeUndefined();
    expect(card?.questionMultiSelect).toBeUndefined();
  });

  it('keeps the multiSelect shape when there are options to pick from', () => {
    const state = foldAll([
      question({
        question: '哪几节要配练习？',
        options: [
          { id: 's1', label: '第一节' },
          { id: 's2', label: '第二节' },
        ],
        multiSelect: true,
      }),
    ]);
    expect(state.chat[0]).toMatchObject({
      kind: 'question',
      questionMultiSelect: true,
      questionOptions: [
        { id: 's1', label: '第一节' },
        { id: 's2', label: '第二节' },
      ],
    });
  });

  it('an open question carries no options and no multiSelect', () => {
    // multiSelect with nothing to select is not a shape the card can render;
    // it degrades to the open question the payload actually describes.
    const state = foldAll([question({ question: '这门课给谁上？', multiSelect: true })]);
    expect(state.chat[0]).toMatchObject({ kind: 'question', text: '这门课给谁上？' });
    expect(state.chat[0].questionOptions).toBeUndefined();
    expect(state.chat[0].questionMultiSelect).toBeUndefined();
  });

  it('drops malformed options and an empty question', () => {
    const partial = foldAll([
      question({
        question: '选一个',
        options: [
          { id: 'ok', label: '可用' },
          { id: '', label: '没有 id' },
          { label: '只有 label' },
        ],
      }),
    ]);
    expect(partial.chat[0].questionOptions).toEqual([{ id: 'ok', label: '可用' }]);
    // A blank question is not an affordance — no card at all, only the seq.
    const blank = foldAll([question({ question: '   ' })]);
    expect(blank.chat).toEqual([]);
    expect(blank.lastEventId).toBeGreaterThan(0);
  });

  it('the next user message retires every open card, whatever the user said', () => {
    const asked = foldAll([
      ev('session_start', { prompt: 'p' }),
      question({ question: '第一问？', options: [{ id: 'a', label: 'A' }] }),
      ev('session_end', { status: 'succeeded' }),
    ]);
    expect(asked.chat.find((n) => n.kind === 'question')?.questionAnswered).toBeUndefined();
    // Not the option label, not even a real answer: any user message below the
    // card means the decision has moved on and the buttons must go dead.
    const answered = foldEvent(
      asked,
      ev('user_message', { text: '算了，换个话题', delivery: 'queued' }),
    );
    expect(answered.chat.find((n) => n.kind === 'question')?.questionAnswered).toBe(true);
    // …and the bubble is an ordinary user row, with no answer correlation.
    expect(contentOf(answered).at(-1)).toMatchObject({ kind: 'user', text: '算了，换个话题' });
  });

  it('a second question is live while the first one is already answered', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      question({ question: '第一问？', options: [{ id: 'a', label: 'A' }] }),
      ev('user_message', { text: 'A', delivery: 'queued' }),
      question({ question: '第二问？', options: [{ id: 'b', label: 'B' }] }),
    ]);
    const cards = state.chat.filter((n) => n.kind === 'question');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ text: '第一问？', questionAnswered: true });
    expect(cards[1]?.questionAnswered).toBeUndefined();
  });

  it('a cancelled or failed run does NOT answer the question', () => {
    // Only a user message is an answer. A run that died with the question on
    // screen leaves it clickable — that is exactly the state the user is in.
    const cancelled = foldAll([
      question({ question: '继续吗？', options: [{ id: 'y', label: '继续' }] }),
      ev('session_end', { status: 'cancelled' }),
    ]);
    expect(cancelled.chat.find((n) => n.kind === 'question')?.questionAnswered).toBeUndefined();
  });

  it('a re-emitted identical question keeps ONE live card', () => {
    // A crash-retried run can emit `user_question` twice and the event carries
    // no call id, so identity is its content. Two identical live cards would
    // read as two questions (and paint two pinned panels).
    const envelope = {
      question: '先做哪一版大纲？',
      options: [
        { id: 'a', label: '按章节' },
        { id: 'b', label: '按项目' },
      ],
    };
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      question(envelope),
      ev('session_interrupted', { reason: 'runner shutdown' }),
      ev('session_resumed', { attempt: 1 }),
      question(envelope),
    ]);
    expect(state.chat.filter((n) => n.kind === 'question')).toHaveLength(1);
  });

  it('a DIFFERENT question, or the same one after an answer, still gets its own card', () => {
    const base = { question: '先做哪一版大纲？', options: [{ id: 'a', label: '按章节' }] };
    // Same text, different option set: a different question.
    const varied = foldAll([
      question(base),
      question({ ...base, options: [{ id: 'a', label: '按周' }] }),
    ]);
    expect(varied.chat.filter((n) => n.kind === 'question')).toHaveLength(2);
    // Same text, different pick mode: also different.
    const modes = foldAll([
      question({ ...base, options: [...base.options, { id: 'b', label: '按项目' }] }),
      question({
        ...base,
        options: [...base.options, { id: 'b', label: '按项目' }],
        multiSelect: true,
      }),
    ]);
    expect(modes.chat.filter((n) => n.kind === 'question')).toHaveLength(2);
    // Asked, answered, asked again: a second decision point, not a duplicate.
    const again = foldAll([
      question(base),
      ev('user_message', { text: '按章节', delivery: 'queued' }),
      question(base),
    ]);
    const cards = again.chat.filter((n) => n.kind === 'question');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.questionAnswered).toBe(true);
    expect(cards[1]?.questionAnswered).toBeUndefined();
  });

  it('a cold replay paints a historical card as already answered', () => {
    // The whole point of deriving `questionAnswered` in the fold: a refresh
    // must not offer buttons for a decision made an hour ago, and must not
    // flash them live for a frame either.
    const frames: WorkbenchEvent[] = [
      ev('session_start', { prompt: '做一门课' }),
      question({ question: '先做哪一版？', options: [{ id: 'a', label: '按章节' }] }),
      ev('session_end', { status: 'succeeded' }),
      ev('user_message', { text: '按章节', delivery: 'queued' }),
      ev('session_resumed', { reason: 'follow_up' }),
      ev('message_end', { message: assistantMessage([{ type: 'text', text: '好，按章节。' }]) }),
      ev('session_end', { status: 'succeeded' }),
    ];
    const live = foldEvents(blankFold, frames);
    const replayed = foldEvents(blankFold, compactReplayEvents(frames));
    expect(replayed.chat).toEqual(live.chat);
    expect(replayed.chat.find((n) => n.kind === 'question')).toMatchObject({
      kind: 'question',
      questionAnswered: true,
    });
  });

  it('an overlapping replay of a question run produces the same state', () => {
    const frames: WorkbenchEvent[] = [
      ev('session_start', { prompt: 'p' }),
      question({
        question: '哪几节要配练习？',
        options: [
          { id: 's1', label: '第一节' },
          { id: 's2', label: '第二节' },
        ],
        multiSelect: true,
      }),
      ev('session_end', { status: 'succeeded' }),
      ev('user_message', { text: '第一节、第二节', delivery: 'queued' }),
    ];
    const clean = foldEvents(blankFold, frames);
    const overlap = foldEvents(foldEvents(blankFold, frames.slice(0, 3)), frames.slice(1));
    expect(overlap).toEqual(clean);
  });
});

describe('replay idempotency', () => {
  const script = () => [
    ev('session_start', { prompt: '给我讲讲光的折射' }),
    ev('message_start', { message: assistantMessage([]) }),
    ev('message_update', {
      message: assistantMessage([
        { type: 'thinking', thinking: '想一下' },
        { type: 'text', text: '好的' },
      ]),
    }),
    ev('message_end', {
      message: assistantMessage([
        { type: 'thinking', thinking: '想一下' },
        { type: 'text', text: '好的，开始规划。' },
      ]),
    }),
    ev('tool_execution_start', {
      toolCallId: 'tc1',
      toolName: 'generate_outline',
      args: { requirement: '…' },
    }),
    ev('tool_execution_end', {
      toolCallId: 'tc1',
      toolName: 'generate_outline',
      result: {
        content: [{ type: 'text', text: 'planned' }],
        details: { courseTitle: '光的折射', pages: [{ order: 1, title: '引入', type: 'slide' }] },
      },
      isError: false,
    }),
    ev('checkpoint', {
      tool: 'generate_outline',
      outline: [{ order: 1, title: '引入', type: 'slide' }],
      courseTitle: '光的折射',
    }),
    ev('checkpoint', { tool: 'generate_scene', order: 1, sceneId: 'scene-1' }),
    ev('session_end', { status: 'succeeded', toolCalls: 2 }),
  ];

  it('an event applied twice is a no-op', () => {
    const events = script();
    const once = foldAll(events);
    let twice = once;
    for (const e of events) twice = foldEvent(twice, e);
    expect(twice).toEqual(once);
  });

  it('an overlapping replay produces the same state as a clean run', () => {
    const events = script();
    const clean = foldAll(events);
    const overlap = foldAll(events.slice(3), foldAll(events.slice(0, 5)));
    expect(overlap).toEqual(clean);
  });

  it('user_message with steer delivery folds the bubble and the note as a pair', () => {
    const state = foldAll([ev('user_message', { text: '第三页换个例子', delivery: 'steer' })]);
    expect(state.chat[0]).toMatchObject({ kind: 'user', text: '第三页换个例子' });
    expect(state.chat[1]).toMatchObject({ kind: 'system', tone: 'info' });
  });

  it('user_message with queued delivery is just the bubble (a new run follows)', () => {
    const state = foldAll([ev('user_message', { text: '再加一页总结', delivery: 'queued' })]);
    expect(contentOf(state)).toHaveLength(1);
    expect(state.chat[0]).toMatchObject({ kind: 'user', text: '再加一页总结' });
  });

  it('user_message with materials renders the attachments on the bubble', () => {
    const state = foldAll([
      ev('user_message', {
        text: '按这份讲义来',
        delivery: 'queued',
        materials: [{ path: 'materials/lecture.pdf', originalName: '讲义.pdf' }],
      }),
    ]);
    expect(state.chat[0].kind).toBe('user');
    expect(state.chat[0]).toMatchObject({
      text: '按这份讲义来',
      materials: ['讲义.pdf'],
    });
  });

  it('user_message with LEGACY string-form materials still renders the names', () => {
    // Written by the first PR4 build; the durable log keeps it forever.
    const state = foldAll([
      ev('user_message', {
        text: '按这份讲义来',
        delivery: 'queued',
        materials: ['materials/lecture.pdf（讲义.pdf）'],
      }),
    ]);
    expect(state.chat[0]).toMatchObject({
      text: '按这份讲义来',
      materials: ['讲义.pdf'],
    });
  });
});

describe('materials', () => {
  it('folds extraction frames without surfacing them in the chat', () => {
    // Screenshot feedback: the "extracting materials" lines were debug texture, so
    // extraction progress/completion frames produce NO visible chat row — the
    // agent's own reply carries what the materials produced. The frame still
    // consumes its seq, so a replay never re-serves it.
    const events = [
      ev('material_extraction', {
        materialId: 'mat_source',
        originalName: '讲义.pdf',
        status: 'running',
      }),
      ev('material_extraction', {
        materialId: 'mat_source',
        originalName: '讲义.pdf',
        status: 'done',
        stats: { chars: 20, pages: 1, imageCount: 1 },
      }),
    ];
    const state = foldAll(events);
    expect(state.chat).toEqual([]);
    expect(state.lastEventId).toBe(events[events.length - 1].id);
  });

  it('stays empty for old extraction events without an original filename', () => {
    const events = [ev('material_extraction', { materialId: 'mat_source', status: 'running' })];
    const state = foldAll(events);
    expect(state.chat).toEqual([]);
    expect(state.lastEventId).toBe(events[events.length - 1].id);
  });
});

describe('session_resumed with repairedToolCalls', () => {
  // A worker dying mid-tool-call leaves a card that never sees
  // `tool_execution_end`; the resuming runner names those calls in
  // `repairedToolCalls`. The fold must settle them, or they pulse "running"
  // forever.
  it('marks repaired cards failed and clears the generating marker', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('tool_execution_start', {
        toolCallId: 'dead-scene',
        toolName: 'generate_scene',
        args: { order: 2 },
      }),
      ev('tool_execution_start', {
        toolCallId: 'still-open',
        toolName: 'list_scenes',
        args: {},
      }),
      ev('session_resumed', {
        attempt: 2,
        transcriptMessages: 7,
        repairedToolCalls: ['dead-scene'],
      }),
    ]);
    const dead = state.chat.find((n) => n.toolCallId === 'dead-scene');
    expect(dead).toMatchObject({ toolState: 'failed' });
    expect(dead?.toolResultText).toContain('重启');
    expect(dead?.toolEndedAt).toBeDefined();
    // The dead generate_scene no longer owns the "writing page N" marker.
    expect(state.generatingOrder).toBeNull();
    // A call the resume did NOT repair is untouched.
    const other = state.chat.find((n) => n.toolCallId === 'still-open');
    expect(other).toMatchObject({ toolState: 'running' });
    // The recovery line still lands (last durable row; the gap indicator may
    // follow it).
    const rows = contentOf(state);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'system', tone: 'info' });
    expect(state.status).toBe('running');
  });

  it('a resume without repairs changes no tool card', () => {
    const state = foldAll([
      ev('tool_execution_start', { toolCallId: 'tc1', toolName: 'list_scenes', args: {} }),
      ev('session_resumed', { attempt: 2, repairedToolCalls: [] }),
    ]);
    expect(state.chat[0]).toMatchObject({ toolState: 'running' });
  });

  it('never rewrites a FINISHED card the resume lists as repaired', () => {
    // The worker died after appending tool_execution_end but before saving the
    // transcript: planResume still names the call, but the card is done and
    // its real result must survive.
    const state = foldAll([
      ev('tool_execution_start', {
        toolCallId: 'finished',
        toolName: 'generate_scene',
        args: { order: 1 },
      }),
      ev('tool_execution_end', {
        toolCallId: 'finished',
        toolName: 'generate_scene',
        result: {
          content: [{ type: 'text', text: 'persisted' }],
          details: { order: 1, title: '折射' },
        },
        isError: false,
      }),
      ev('session_resumed', { attempt: 2, repairedToolCalls: ['finished'] }),
    ]);
    const card = state.chat.find((n) => n.toolCallId === 'finished');
    expect(card).toMatchObject({ toolState: 'done', toolResultText: 'persisted' });
    expect(card?.toolDetails).toEqual({ order: 1, title: '折射' });
  });
});

describe('session_end cancelled settles the tools left in flight', () => {
  // The runner aborts its in-flight calls, so a well-behaved tool reports its
  // own error and its card settles through `tool_execution_end`. This is the
  // display backstop for everything else: a tool that ignores the signal, or a
  // call that raced the loop's exit, must not keep pulsing "running" under a
  // transcript that already says the run stopped.
  it('turns every running card into a failure with the abort cause', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('tool_execution_start', {
        toolCallId: 'in-flight',
        toolName: 'generate_scene',
        args: { order: 3 },
      }),
      ev('tool_execution_start', { toolCallId: 'also-open', toolName: 'web_search', args: {} }),
      ev('session_end', { status: 'cancelled' }),
    ]);
    for (const id of ['in-flight', 'also-open']) {
      const card = state.chat.find((n) => n.toolCallId === id);
      expect(card, id).toMatchObject({ kind: 'tool', toolState: 'failed' });
      expect(card?.toolResultText).toContain('已被停止');
      expect(card?.toolEndedAt).toBeDefined();
    }
    // The cancelled generate_scene no longer owns the "writing page N" marker.
    expect(state.generatingOrder).toBeNull();
    // The caption still closes the run, and stays last.
    const rows = contentOf(state);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'boundary', text: '本轮生成已停止' });
    expect(state.status).toBe('cancelled');
  });

  it('leaves a card that already reported its own abort error alone', () => {
    // The paired backend change makes tools fail fast on the signal, so this is
    // the normal path: the real result must survive, not be overwritten by the
    // synthetic one.
    const state = foldAll([
      ev('tool_execution_start', { toolCallId: 'tc1', toolName: 'web_search', args: {} }),
      ev('tool_execution_end', {
        toolCallId: 'tc1',
        toolName: 'web_search',
        result: { content: [{ type: 'text', text: 'aborted by signal' }] },
        isError: true,
      }),
      ev('session_end', { status: 'cancelled' }),
    ]);
    const card = state.chat.find((n) => n.toolCallId === 'tc1');
    expect(card).toMatchObject({ toolState: 'failed', toolResultText: 'aborted by signal' });
  });

  it('never rewrites a card that finished successfully before the stop', () => {
    const state = foldAll([
      ev('tool_execution_start', {
        toolCallId: 'done1',
        toolName: 'generate_scene',
        args: { order: 1 },
      }),
      ev('tool_execution_end', {
        toolCallId: 'done1',
        toolName: 'generate_scene',
        result: { content: [{ type: 'text', text: 'persisted' }], details: { order: 1 } },
        isError: false,
      }),
      ev('session_end', { status: 'cancelled' }),
    ]);
    expect(state.chat.find((n) => n.toolCallId === 'done1')).toMatchObject({
      toolState: 'done',
      toolResultText: 'persisted',
    });
  });

  it('is scoped to a cancel — a succeeded run touches no card', () => {
    const state = foldAll([
      ev('tool_execution_start', { toolCallId: 'tc1', toolName: 'web_search', args: {} }),
      ev('session_end', { status: 'succeeded' }),
    ]);
    expect(state.chat.find((n) => n.toolCallId === 'tc1')).toMatchObject({
      toolState: 'running',
    });
  });

  it('replays to the same view, and applying the cancel twice changes nothing', () => {
    const events = [
      ev('session_start', { prompt: 'p' }),
      ev('tool_execution_start', { toolCallId: 'tc1', toolName: 'web_search', args: {} }),
      ev('session_end', { status: 'cancelled' }),
    ];
    const live = foldAll(events);
    // A cold replay of the same prefix (what a reconnect or a reopened
    // conversation folds) lands on the same cards.
    const replayed = foldAll(compactReplayEvents(events));
    expect(replayed.chat).toEqual(live.chat);
    expect(replayed.generatingOrder).toBe(live.generatingOrder);
    // And the overlap a `Last-Event-ID` reconnect can deliver is a no-op.
    expect(foldEvent(live, events[events.length - 1])).toEqual(live);
  });
});

describe('the waiting (gap) indicator', () => {
  const waitingOf = (state: WorkbenchFold) => state.chat.filter((n) => n.kind === 'waiting');

  it('session_start opens the gap; the first content delta closes it', () => {
    let state = foldAll([ev('session_start', { prompt: 'p' })]);
    expect(waitingOf(state)).toHaveLength(1);
    expect(state.waitingKey).not.toBeNull();
    expect(state.chat[0].kind).toBe('user');
    expect(state.chat[1].kind).toBe('waiting');

    state = foldEvent(
      state,
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '你好' }]) }),
    );
    expect(waitingOf(state)).toHaveLength(0);
    expect(state.waitingKey).toBeNull();
  });

  it('message_start keeps the gap open; a thinking delta closes it', () => {
    let state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_start', { message: assistantMessage([]) }),
    ]);
    expect(waitingOf(state)).toHaveLength(1);
    state = foldEvent(
      state,
      ev('message_update', { message: assistantMessage([{ type: 'thinking', thinking: '嗯' }]) }),
    );
    expect(waitingOf(state)).toHaveLength(0);
  });

  it('tool end does not reopen waiting once the turn already has parts', () => {
    const state = foldAll([
      ev('tool_execution_start', { toolCallId: 'tc1', toolName: 'list_scenes', args: {} }),
      ev('tool_execution_end', {
        toolCallId: 'tc1',
        toolName: 'list_scenes',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
      }),
    ]);
    expect(waitingOf(state)).toHaveLength(0);
  });

  it('a settled run leaves no gap node behind', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_start', { message: assistantMessage([]) }),
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '答' }]) }),
      ev('message_end', { message: assistantMessage([{ type: 'text', text: '答。' }]) }),
      ev('session_end', { status: 'succeeded' }),
    ]);
    expect(waitingOf(state)).toHaveLength(0);
    expect(state.waitingKey).toBeNull();
  });

  it('a mid-gap prefix replays deterministically (overlap = clean)', () => {
    const events = [
      ev('session_start', { prompt: 'p' }),
      ev('message_start', { message: assistantMessage([]) }),
    ];
    const clean = foldAll(events);
    const overlap = foldAll(events.slice(1), foldAll(events.slice(0, 1)));
    expect(overlap).toEqual(clean);
    expect(waitingOf(clean)).toHaveLength(1);
  });

  it('a queued user message reopens the gap; session_end closes it', () => {
    let state = foldAll([ev('session_end', { status: 'succeeded' })]);
    expect(waitingOf(state)).toHaveLength(0);
    state = foldEvent(state, ev('user_message', { text: '再来一页', delivery: 'queued' }));
    expect(waitingOf(state)).toHaveLength(1);
    state = foldEvent(state, ev('session_end', { status: 'succeeded' }));
    expect(waitingOf(state)).toHaveLength(0);
  });
});

describe('steer-armed waiting', () => {
  const waitingOf = (state: WorkbenchFold) => state.chat.filter((n) => n.kind === 'waiting');

  it('a steered message does not flash waiting once the turn already has parts', () => {
    let state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '先做着' }]) }),
    ]);
    expect(waitingOf(state)).toHaveLength(0);
    state = foldEvent(state, ev('user_message', { text: '顺便加个例子', delivery: 'steer' }));
    expect(waitingOf(state)).toHaveLength(0);
    state = foldEvent(
      state,
      ev('message_end', { message: assistantMessage([{ type: 'text', text: '先做着' }]) }),
    );
    expect(waitingOf(state)).toHaveLength(0);
    expect(state.chat.filter((n) => n.kind === 'assistant')).toHaveLength(1);
  });

  it('steer plus tool end still does not reopen waiting', () => {
    const state = foldAll([
      ev('tool_execution_start', { toolCallId: 'tc1', toolName: 'list_scenes', args: {} }),
      ev('user_message', { text: '改一下', delivery: 'steer' }),
      ev('tool_execution_end', {
        toolCallId: 'tc1',
        toolName: 'list_scenes',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
      }),
    ]);
    expect(waitingOf(state)).toHaveLength(0);
  });

  it('steer finalizes the in-flight text in place, no extra waiting row', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '半截' }]) }),
      ev('user_message', { text: 'steer', delivery: 'steer' }),
      ev('message_end', { message: assistantMessage([{ type: 'text', text: '半截话完了' }]) }),
    ]);
    expect(state.chat.map((n) => n.kind)).toEqual(['user', 'assistant', 'user', 'system']);
    expect(state.chat[1]).toMatchObject({
      kind: 'assistant',
      text: '半截话完了',
      streaming: false,
    });
  });

  it('queued delivery still opens immediately', () => {
    const state = foldAll([ev('user_message', { text: '再来一页', delivery: 'queued' })]);
    expect(waitingOf(state)).toHaveLength(1);
    expect(state.waitingArmed).toBe(false);
  });

  it('a run end disarms without leaving a bar', () => {
    let state = foldAll([ev('user_message', { text: 'x', delivery: 'steer' })]);
    expect(state.waitingArmed).toBe(true);
    state = foldEvent(state, ev('session_end', { status: 'succeeded' }));
    expect(state.waitingArmed).toBe(false);
    expect(waitingOf(state)).toHaveLength(0);
  });
});

describe('interrupted streams settle at message_start', () => {
  it('a resume that re-emits message_start keeps writing the same bubble', () => {
    const body = assistantMessage([{ type: 'text', text: 'HTML 全部读到了，UI 问题定位清楚了' }]);
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('message_update', { message: body }),
      ev('session_interrupted', { reason: 'runner shutdown', attempt: 1 }),
      ev('session_resumed', { attempt: 2, transcriptMessages: 4 }),
      ev('message_start', { message: body }),
      ev('message_update', { message: body }),
      ev('message_end', { message: body }),
    ]);
    const assistants = state.chat.filter((n) => n.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      text: 'HTML 全部读到了，UI 问题定位清楚了',
      streaming: false,
    });
  });

  it('a toolResult message_start does not reset the current assistant', () => {
    const body = assistantMessage([{ type: 'text', text: '准备改这一页' }]);
    const state = foldAll([
      ev('message_update', { message: body }),
      ev('message_start', { message: { role: 'toolResult', content: [] } }),
      ev('message_end', { message: { role: 'toolResult', content: [] } }),
      ev('message_update', { message: body }),
    ]);
    expect(state.chat.filter((n) => n.kind === 'assistant')).toHaveLength(1);
  });

  it('a finished reply plus a later message_start is a new bubble', () => {
    const state = foldAll([
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '先说完' }]) }),
      ev('message_end', { message: assistantMessage([{ type: 'text', text: '先说完' }]) }),
      ev('message_start', { message: assistantMessage([]) }),
      ev('message_update', { message: assistantMessage([{ type: 'text', text: '下一句' }]) }),
    ]);
    const assistants = state.chat.filter((n) => n.kind === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants.map((n) => n.text)).toEqual(['先说完', '下一句']);
  });
});

/**
 * Fold-local fencing: attempt is a consecutive-failure counter, not a lifetime
 * generation. Lifecycle anchors may therefore reset epoch downward; ordinary
 * lower-attempt frames are stale until such an anchor arrives.
 */
describe('generation fencing', () => {
  const asAttempt = (e: WorkbenchEvent, attempt: number): WorkbenchEvent => ({ ...e, attempt });

  it('drops stale-generation frames after a crash resume', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      asAttempt(ev('session_resumed', { reason: 'crash', repairedToolCalls: [] }), 2),
      // The superseded attempt keeps emitting: none of it may land.
      asAttempt(
        ev('message_update', {
          message: assistantMessage([{ type: 'thinking', thinking: '僵尸的思考' }]),
        }),
        1,
      ),
      asAttempt(
        ev('tool_execution_start', { toolCallId: 'zombie', toolName: 'generate_scene', args: {} }),
        1,
      ),
      asAttempt(ev('checkpoint', { outline: [], courseTitle: '僵尸课程' }), 1),
      asAttempt(ev('agent_end', { messages: [] }), 1),
      // The current generation continues normally (its events carry the new
      // epoch's attempt).
      asAttempt(
        ev('message_update', {
          message: assistantMessage([{ type: 'text', text: '新一代的回答' }]),
        }),
        2,
      ),
    ]);
    expect(state.chat.some((n) => n.text.includes('僵尸的思考'))).toBe(false);
    expect(state.chat.some((n) => n.toolCallId === 'zombie')).toBe(false);
    expect(state.courseTitle).toBeNull();
    expect(state.status).toBe('running');
    const assistants = state.chat.filter((n) => n.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toBe('新一代的回答');
  });

  it('accepts a newer terminal lifecycle frame as an epoch anchor', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      ev('session_interrupted', { reason: 'runner shutdown', attempt: 1 }),
      asAttempt(ev('session_end', { status: 'succeeded', attempt: 2 }), 2),
    ]);
    expect(state.status).toBe('succeeded');
    expect(state.epoch).toBe(2);
  });

  it('accepts attempt 1 after a six-failure epoch when a clean run reset is lifecycle-anchored', () => {
    const state = foldAll([
      asAttempt(ev('session_start', { prompt: 'old failure chain' }), 6),
      asAttempt(ev('session_end', { status: 'succeeded' }), 6),
      // finishSession reset attempt to 0; the next claim is attempt 1.
      asAttempt(ev('session_resumed', { reason: 'follow_up', repairedToolCalls: [] }), 1),
      asAttempt(
        ev('message_update', {
          message: assistantMessage([{ type: 'text', text: 'new run accepted' }]),
        }),
        1,
      ),
    ]);
    expect(state.epoch).toBe(1);
    expect(state.status).toBe('running');
    expect(
      state.chat.some((node) => node.kind === 'assistant' && node.text === 'new run accepted'),
    ).toBe(true);
  });

  it('does not let a higher-attempt ordinary zombie frame re-anchor epoch after reset-down', () => {
    const state = foldAll([
      asAttempt(ev('session_start', { prompt: 'old failure chain' }), 6),
      asAttempt(ev('session_end', { status: 'succeeded' }), 6),
      asAttempt(ev('session_resumed', { reason: 'follow_up', repairedToolCalls: [] }), 1),
      asAttempt(
        ev('message_update', {
          message: assistantMessage([{ type: 'text', text: 'attempt-6 zombie' }]),
        }),
        6,
      ),
      asAttempt(
        ev('message_update', {
          message: assistantMessage([{ type: 'text', text: 'attempt-1 current' }]),
        }),
        1,
      ),
      asAttempt(ev('session_end', { status: 'succeeded' }), 1),
    ]);
    expect(state.epoch).toBe(1);
    expect(state.status).toBe('succeeded');
    expect(state.chat.some((node) => node.text.includes('attempt-6 zombie'))).toBe(false);
    expect(state.chat.some((node) => node.text.includes('attempt-1 current'))).toBe(true);
  });

  it('accepts a pre-anchor ordinary frame without letting it establish epoch', () => {
    const state = foldAll([
      asAttempt(
        ev('message_update', {
          message: assistantMessage([{ type: 'text', text: 'legacy first frame' }]),
        }),
        4,
      ),
    ]);
    expect(state.epoch).toBe(0);
    expect(state.chat.some((node) => node.text.includes('legacy first frame'))).toBe(true);
  });

  it('control-plane events (attempt 0) are exempt from the fence', () => {
    const state = foldAll([
      ev('session_start', { prompt: 'p' }),
      asAttempt(ev('session_resumed', { reason: 'crash', repairedToolCalls: [] }), 2),
      { ...ev('user_message', { text: '还在吗', delivery: 'queued' }), attempt: 0 },
    ]);
    expect(state.chat.some((n) => n.kind === 'user' && n.text === '还在吗')).toBe(true);
  });

  it('dropped frames still consume their seq (idempotent reattach)', () => {
    const frames = [
      ev('session_start', { prompt: 'p' }),
      asAttempt(ev('session_resumed', { reason: 'crash', repairedToolCalls: [] }), 2),
      asAttempt(
        ev('message_update', { message: assistantMessage([{ type: 'text', text: 'x' }]) }),
        1,
      ),
    ];
    const state = foldAll(frames);
    expect(state.lastEventId).toBe(frames[2].id);
  });
});

describe('thinking bar timing', () => {
  it('a thinking duration is written exactly once and never extends', () => {
    let state = foldAll([ev('session_start', { prompt: 'p' }, 1000)]);
    state = foldEvent(
      state,
      ev(
        'message_update',
        { message: assistantMessage([{ type: 'thinking', thinking: '想' }]) },
        1500,
      ),
    );
    // Text starts streaming: the bar keeps running — the first text frame is
    // a volatile delta, and settling on it would diverge from replay. The
    // clock stops at the DURABLE boundary instead.
    state = foldEvent(
      state,
      ev(
        'message_update',
        {
          message: assistantMessage([
            { type: 'thinking', thinking: '想想' },
            { type: 'text', text: '答' },
          ]),
        },
        4000,
      ),
    );
    const bar = state.chat.find((n) => n.kind === 'thinking');
    expect(bar).toMatchObject({ streaming: true, startedAt: 1000 });
    expect(bar?.endedAt).toBeUndefined();

    // message_end is the durable end of the reasoning part; it freezes the
    // duration exactly once, and no later event may extend it.
    state = foldEvent(
      state,
      ev(
        'message_end',
        {
          message: assistantMessage([
            { type: 'thinking', thinking: '想想' },
            { type: 'text', text: '答案。' },
          ]),
        },
        9000,
      ),
    );
    const after = state.chat.find((n) => n.kind === 'thinking');
    expect(after).toMatchObject({ streaming: false, startedAt: 1000, endedAt: 9000 });

    // A second message_end (replay overlap, duplicate boundary) is a no-op.
    state = foldEvent(
      state,
      ev(
        'message_end',
        {
          message: assistantMessage([
            { type: 'thinking', thinking: '想想' },
            { type: 'text', text: '答案。' },
          ]),
        },
        12000,
      ),
    );
    const twice = state.chat.find((n) => n.kind === 'thinking');
    expect(twice).toMatchObject({ streaming: false, startedAt: 1000, endedAt: 9000 });
  });

  it('thinking_end settles the bar the instant reasoning hands over to text', () => {
    let state = foldAll([ev('session_start', { prompt: 'p' }, 1000)]);
    state = foldEvent(
      state,
      ev(
        'message_update',
        { message: assistantMessage([{ type: 'thinking', thinking: '想' }]) },
        1500,
      ),
    );
    // The runner's durable hand-over marker lands WHILE text is still
    // streaming: the clock stops here, not at message_end, so there is no
    // thinking window lingering over tokens that are already visible.
    state = foldEvent(state, ev('thinking_end', {}, 2600));
    const bar = state.chat.find((n) => n.kind === 'thinking');
    expect(bar).toMatchObject({ streaming: false, startedAt: 1000, endedAt: 2600 });

    // The text keeps streaming afterwards; the bar must not move again.
    state = foldEvent(
      state,
      ev(
        'message_update',
        {
          message: assistantMessage([
            { type: 'thinking', thinking: '想' },
            { type: 'text', text: '答' },
          ]),
        },
        3000,
      ),
    );
    state = foldEvent(
      state,
      ev(
        'message_end',
        {
          message: assistantMessage([
            { type: 'thinking', thinking: '想' },
            { type: 'text', text: '答案。' },
          ]),
        },
        9000,
      ),
    );
    const after = state.chat.find((n) => n.kind === 'thinking');
    expect(after).toMatchObject({ streaming: false, startedAt: 1000, endedAt: 2600 });
  });

  it('short text: thinking_end still lands with message_end, and only once', () => {
    // A short reply streams its text deltas inside one 150ms throttle window,
    // so the runner never persists a text-bearing `message_update` (the proof
    // frame) — the durable stream jumps straight from thinking to
    // `message_end`. The runner's fallback now emits the missing
    // `thinking_end` marker at the end frame's OWN ts; this pins the durable
    // sequence a live viewer of that run (and its replay) sees.
    let state = foldAll([ev('session_start', { prompt: 'p' }, 1000)]);
    state = foldEvent(
      state,
      ev(
        'message_update',
        { message: assistantMessage([{ type: 'thinking', thinking: '想' }]) },
        1500,
      ),
    );
    // No persisted text-bearing update between here and message_end.
    state = foldEvent(
      state,
      ev(
        'message_end',
        {
          message: assistantMessage([
            { type: 'thinking', thinking: '想' },
            { type: 'text', text: '答案。' },
          ]),
        },
        9000,
      ),
    );
    // The fallback marker rides the end frame's ts: the bar settles at 9000,
    // exactly the instant the end frame itself would settle it.
    state = foldEvent(state, ev('thinking_end', {}, 9000));

    const bars = state.chat.filter((n) => n.kind === 'thinking');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ streaming: false, startedAt: 1000, endedAt: 9000 });

    // Emitted exactly once: a replayed copy of the marker is a no-op.
    state = foldEvent(state, ev('thinking_end', {}, 9000));
    const twice = state.chat.filter((n) => n.kind === 'thinking');
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ streaming: false, startedAt: 1000, endedAt: 9000 });
  });

  it('replay with thinking_end converges on the same bounds as live', () => {
    const frames: WorkbenchEvent[] = [
      ev('session_start', { prompt: 'p' }, 1000),
      ev(
        'message_update',
        { message: assistantMessage([{ type: 'thinking', thinking: 'a' }]) },
        1500,
      ),
      ev(
        'message_update',
        { message: assistantMessage([{ type: 'thinking', thinking: 'ab' }]) },
        2000,
      ),
      ev(
        'message_update',
        {
          message: assistantMessage([
            { type: 'thinking', thinking: 'ab' },
            { type: 'text', text: '答' },
          ]),
        },
        2400,
      ),
      ev('thinking_end', {}, 2600),
      ev(
        'message_end',
        {
          message: assistantMessage([
            { type: 'thinking', thinking: 'ab' },
            { type: 'text', text: '答案。' },
          ]),
        },
        9000,
      ),
    ];
    const live = foldEvents(blankFold, frames);
    // Replay compaction keeps first+last updates and every durable frame; the
    // settle marker survives, so the folded bounds are identical.
    const replayed = foldEvents(blankFold, compactReplayEvents(frames));
    const liveBar = live.chat.find((n) => n.kind === 'thinking');
    const replayBar = replayed.chat.find((n) => n.kind === 'thinking');
    expect(replayBar).toMatchObject({
      startedAt: liveBar?.startedAt,
      endedAt: liveBar?.endedAt,
      streaming: false,
    });
  });

  it('replay keeps the exact thinking bounds the live viewer saw', () => {
    const frames: WorkbenchEvent[] = [
      ev('session_start', { prompt: 'p' }, 1000),
      ev(
        'message_update',
        { message: assistantMessage([{ type: 'thinking', thinking: 'a' }]) },
        1500,
      ),
      ev(
        'message_update',
        { message: assistantMessage([{ type: 'thinking', thinking: 'ab' }]) },
        2000,
      ),
      ev(
        'message_update',
        { message: assistantMessage([{ type: 'thinking', thinking: 'abc' }]) },
        4000,
      ),
      ev(
        'message_end',
        { message: assistantMessage([{ type: 'thinking', thinking: 'abc' }]) },
        4500,
      ),
    ];
    const live = foldEvents(blankFold, frames);
    const replayed = foldEvents(blankFold, compactReplayEvents(frames));
    const liveBar = live.chat.find((n) => n.kind === 'thinking');
    const replayBar = replayed.chat.find((n) => n.kind === 'thinking');
    expect(replayBar).toMatchObject({
      text: liveBar?.text,
      startedAt: liveBar?.startedAt,
      endedAt: liveBar?.endedAt,
    });
  });
});

describe('checkpoint events keep their progress role, not a freshness role (#1960 Part 2)', () => {
  it('a stageId/detail-only checkpoint (set_roster, edit_deck delete) folds its page rows, not a refetch counter', () => {
    const state = foldAll([
      ev('checkpoint', { tool: 'set_roster', stageId: 'stage-a', detail: '4 agents' }),
      ev('checkpoint', { tool: 'edit_deck', stageId: 'stage-a', detail: 'deleted page 2' }),
    ]);
    // The checkpoint's job is showing agent progress; the canvas freshness is
    // the DB triggers + manifest sync's job. No per-session counter remains.
    expect('courseRevision' in state).toBe(false);
    expect(state.touchedStageIds).toEqual(['stage-a']);
  });
});

describe('v1 lifecycle replay bridge (R6-P2-5)', () => {
  it('a v1-only transcript rebuilds its created-stage tabs and final active stage', () => {
    // A faithful v1 fixture: stage_created arrived via library_changed and
    // switch_stage via active_stage_changed — no stage_link frames exist in
    // these logs, and the fixture deliberately does not fabricate any.
    const state = foldAll([
      ev('session_start', { prompt: '做个系列课' }),
      ev('library_changed', { change: 'stage_created', stageId: 'stage-v1-a' }),
      ev('library_changed', { change: 'stage_created', stageId: 'stage-v1-b' }),
      ev('library_changed', { change: 'folder_created', folderId: 'fold-1' }),
      ev('active_stage_changed', { stageId: 'stage-v1-b', name: '第二课' }),
    ]);
    expect(state.stageLinkStageIds).toEqual(['stage-v1-a', 'stage-v1-b']);
    expect(state.stageId).toBe('stage-v1-b');
    expect(state.libraryRevision).toBe(3);
  });

  it('current logs carrying both stage_link and stage_created dedupe to one tab', () => {
    const state = foldAll([
      ev('stage_link', { stageId: 'stage-x', title: 'T', url: '/classroom/stage-x' }),
      ev('library_changed', { change: 'stage_created', stageId: 'stage-x' }),
    ]);
    expect(state.stageLinkStageIds).toEqual(['stage-x']);
  });

  it('a malformed active_stage_changed frame cannot erase a known stage', () => {
    const state = foldAll([
      ev('active_stage_changed', { stageId: 'stage-known' }),
      ev('active_stage_changed', { stageId: '' }),
      ev('active_stage_changed', {}),
    ]);
    expect(state.stageId).toBe('stage-known');
  });
});

/**
 * Detaching is not "about to replay".
 *
 * `replaying` is only ever read as "hold the catch-up spinner up", and the hook
 * that clears it needs a session id — so leaving it true on detach was a spinner
 * nothing could turn off. A brand-new conversation lands in exactly that state.
 */
describe('detach', () => {
  it('leaves nothing attached and nothing replaying', () => {
    const store = useWorkbenchStore.getState();
    store.attach('session-1', 'stage-1');
    expect(useWorkbenchStore.getState().replaying).toBe(true);

    useWorkbenchStore.getState().detach();
    const after = useWorkbenchStore.getState();
    expect(after.sessionId).toBeNull();
    expect(after.attached).toBe(false);
    expect(after.replaying).toBe(false);
  });

  it('still arms the replay when a session IS attached', () => {
    useWorkbenchStore.getState().detach();
    useWorkbenchStore.getState().attach('session-2', 'stage-2');
    expect(useWorkbenchStore.getState().replaying).toBe(true);
    useWorkbenchStore.getState().detach();
  });
});
