/**
 * Entering a DRAFT conversation resets the store completely.
 *
 * Pressing new-chat while the previous session is still generating drops
 * `?session=` from the URL, and the shell answers by detaching the store. That
 * transition has now leaked run state THREE TIMES, always the same shape: one
 * field survived, some piece of chrome branched on it, and the fix cleared that
 * one field.
 *
 *   1. `replaying` stayed true → the middle column sat on a catch-up spinner
 *      that nothing could ever turn off (no session, so the hook that clears it
 *      never runs).
 *   2. the pane header read the same flag → connecting with a live spinner beside an
 *      empty composer.
 *   3. `status` stayed at the initial `connecting`, which `isRunLive` counts as a
 *      LIVE RUN → the composer showed the red STOP square and the interrupt
 *      placeholder, and the idle empty state was suppressed, so the
 *      transcript area was simply blank.
 *
 * Three rounds of clearing one field is the wrong shape of fix, so the reset is
 * now a single assignment of `createInitialSessionState()` — and this file is the
 * guard that keeps it total. The first test ENUMERATES the store's own fields
 * rather than naming the ones this bug happened to expose: every field is dirtied
 * by a realistic run, and every field must equal its initial value afterwards. A
 * thirtieth field added to the fold and left out of the reset fails here without
 * anyone having to think of it.
 */
import { describe, expect, it } from 'vitest';

import {
  createInitialSessionState,
  useWorkbenchStore,
  type ChatNode,
  type SessionStatus,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';
// Upstream adaptation: the reference imported these chrome predicates from the
// workbench UI slice (`components/workbench/chat/composer-send-state` and
// `empty-state`), which ships in a later slice. They are inlined here verbatim
// so the store-reset contract stays testable; the UI slice should swap these
// back for the real modules when it lands.

/** Whether the fold itself says a run is in flight. */
function isRunLive(status: SessionStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'connecting';
}

/** Whether the composer should show STOP (the run is live) instead of send. */
function isComposerLive(input: { status: SessionStatus; pendingSend: boolean }): boolean {
  return isRunLive(input.status) || input.pendingSend;
}

/** The chat area's idle placeholder: no rows, no catch-up, no live run. */
function shouldShowWorkbenchEmptyState(input: {
  chat: readonly ChatNode[];
  catchingUp: boolean;
  live: boolean;
}): boolean {
  const { chat, catchingUp, live } = input;
  return chat.length === 0 && !catchingUp && !live;
}

let seq = 0;
function ev(type: string, data: unknown): WorkbenchEvent {
  seq += 1;
  return { id: seq, ts: 1_000 + seq, attempt: 1, type, data };
}

const assistant = (parts: { type: string; text?: string; thinking?: string }[]) => ({
  role: 'assistant',
  content: parts,
});

/**
 * A run that touches EVERY field of the store.
 *
 * Not a minimal repro on purpose: the enumeration below is only meaningful if
 * nothing was already sitting at its initial value, so this drives a real
 * conversation — reasoning, a streaming reply, a writer tool with its traces, a
 * committed page, two classrooms linked, a library write, an open question, a
 * queued follow-up and a steered one — and then asserts that all 29 fields moved.
 */
const RUN: readonly WorkbenchEvent[] = [
  ev('session_start', { prompt: '给我做一门光的折射' }),
  ev('message_update', {
    message: assistant([
      { type: 'thinking', thinking: '先看看已有的课' },
      { type: 'text', text: '好，我先搭大纲' },
    ]),
  }),
  ev('tool_execution_start', {
    toolCallId: 'call-1',
    toolName: 'generate_scene',
    args: { order: 1, stageId: 'stage-a' },
  }),
  ev('trace', { message: '第 1 页 正在渲染' }),
  ev('checkpoint', {
    order: 1,
    title: '折射入门',
    sceneId: 'scene-1',
    stageId: 'stage-a',
    outline: [{ order: 1, title: '折射入门', type: 'slide' }],
    courseTitle: '光的折射',
    skill: 'slide-design',
    skillViolations: ['一处偏离'],
  }),
  ev('stage_link', { stageId: 'stage-b' }),
  ev('library_changed', { change: 'stage_created', stageId: 'stage-c' }),
  ev('user_question', { question: '先做哪一版大纲？', options: [{ id: 'a', label: '按章节' }] }),
  // Queued: the session was idle, so this one opens the LLM gap indicator.
  ev('user_message', { text: '按章节', delivery: 'queued' }),
  // Steered: a run is live, so this one is owed an answer at the next boundary.
  ev('user_message', {
    text: '再加一页',
    delivery: 'steer',
    courseRefs: [{ kind: 'course', stageId: 'stage-d', title: '光的反射' }],
  }),
];

/** Attach a session, fold the run, and dirty the fields the fold does not own. */
function driveARunningSession(): void {
  const store = useWorkbenchStore.getState();
  store.attach('session-1', 'stage-a');
  store.applyEvents(RUN);
  store.finishReplay();
  // Keep both replay fields non-initial so the total-reset guard remains
  // non-vacuous while still exercising the historical stage-link baseline.
  store.setReplaying(true);
  store.setSessionBootstrap({ prompt: '给我做一门光的折射', title: '光的折射课' });
  store.setSessionTitle('光的折射课');
  store.setAttached(true);
  store.setError('stream hiccup');
  store.setPlaybackOn(true);
  // `byUser` so the pin is dirty too — the fold only ever raises `panelOpen`.
  store.setPanelOpen(true, true);
}

/** The store's DATA fields, in a stable order. Actions are not state. */
function stateKeys(): string[] {
  const state = useWorkbenchStore.getState() as unknown as Record<string, unknown>;
  return Object.keys(state)
    .filter((key) => typeof state[key] !== 'function')
    .sort();
}

function snapshot(): Record<string, unknown> {
  return { ...(useWorkbenchStore.getState() as unknown as Record<string, unknown>) };
}

/** Every value in this state is JSON-shaped (no dates, no maps, no functions). */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe('createInitialSessionState is the one source of "no session"', () => {
  it("covers exactly the store's data fields — no more, no fewer", () => {
    // The other half of the guard: the reset can only be total if the factory
    // knows about every field the store has. Add one to the store and forget the
    // factory (or the reverse) and this fails, which is cheaper than discovering
    // it as a fourth round of this bug.
    expect(Object.keys(createInitialSessionState()).sort()).toEqual(stateKeys());
  });

  it('is a fresh object each call, so no two sessions share a chat array', () => {
    const first = createInitialSessionState();
    const second = createInitialSessionState();
    expect(first.chat).not.toBe(second.chat);
    expect(first.pages).not.toBe(second.pages);
    expect(first.plan).not.toBe(second.plan);
  });

  it('says there is no run: idle is not live, so the composer offers SEND', () => {
    const initial = createInitialSessionState();
    expect(initial.status).toBe('idle');
    expect(isRunLive(initial.status)).toBe(false);
    expect(isComposerLive({ status: initial.status, pendingSend: false })).toBe(false);
    expect(initial.replaying).toBe(false);
  });
});

describe('entering a draft conversation while the previous run is live', () => {
  it('resets EVERY field to its initial value (enumerated, not enumerated by hand)', () => {
    useWorkbenchStore.getState().detach();
    driveARunningSession();

    const keys = stateKeys();
    const initial = createInitialSessionState() as unknown as Record<string, unknown>;
    const running = snapshot();

    // Non-vacuity: the comparison below proves nothing about a field that was
    // already sitting at its initial value, so ALL of them must have moved. A new
    // field that this run cannot dirty fails here — deliberately: an unreachable
    // field is one nobody can show is reset either.
    const dirty = keys.filter((key) => !same(running[key], initial[key]));
    expect(dirty).toEqual(keys);

    useWorkbenchStore.getState().detach();

    const after = snapshot();
    const leaked = keys.filter((key) => !same(after[key], initial[key]));
    expect(leaked).toEqual([]);
    // Field by field as well, so a failure names the survivor instead of
    // printing two twenty-nine-key objects.
    for (const key of keys) expect(after[key], `${key} survived the reset`).toEqual(initial[key]);
  });

  it('leaves the composer on SEND with its ordinary placeholder, and the empty state showing', () => {
    useWorkbenchStore.getState().detach();
    driveARunningSession();
    expect(
      isComposerLive({ status: useWorkbenchStore.getState().status, pendingSend: false }),
    ).toBe(true);

    useWorkbenchStore.getState().detach();
    const { status, chat, replaying, sessionId } = useWorkbenchStore.getState();

    // The three things the user actually saw, as the chrome derives them.
    const live = isComposerLive({ status, pendingSend: false });
    expect(live).toBe(false); // send button, not the red STOP square
    expect(live ? 'interruptPlaceholder' : 'continuePlaceholder').toBe('continuePlaceholder');
    // A draft pane has no log to catch up to (see `WorkbenchChat.catchingUp`).
    const catchingUp = false;
    expect(replaying || sessionId === null).toBe(true); // …which is why the term exists
    expect(shouldShowWorkbenchEmptyState({ chat, catchingUp, live })).toBe(true);
    expect(chat).toEqual([]);
  });

  it('does not touch the classroom: the pane is keyed on the URL, not on the fold', () => {
    // `?course=` is untouched by new-chat and the pane's own props are derived from
    // it plus "is any session writing this course", never from the attached fold —
    // so a reset cannot remount the classroom or clear its whiteboard history.
    // Pane visibility comes directly from the shell's host context; no attached
    // fold field participates. What must NOT happen is the reset carrying a stage
    // id (or a playback flag) into the next pane.
    useWorkbenchStore.getState().detach();
    driveARunningSession();
    useWorkbenchStore.getState().detach();
    const after = useWorkbenchStore.getState();
    expect(after.stageId).toBeNull();
    expect(after.playbackOn).toBe(false);
    expect(after.panelPinned).toBe(false);
  });
});

describe('the live run itself is untouched', () => {
  it('switching back to the still-running session restores STOP and the interrupt placeholder', () => {
    useWorkbenchStore.getState().detach();
    driveARunningSession();
    useWorkbenchStore.getState().detach();

    // Coming back re-attaches and replays the durable log — the fold is rebuilt
    // from events, so clearing it above cost nothing.
    useWorkbenchStore.getState().attach('session-1', 'stage-a');
    const attaching = useWorkbenchStore.getState();
    // Attaching is LIVE before a single event arrives: the button must not flash
    // SEND on a session that is generating.
    expect(attaching.status).toBe('connecting');
    expect(attaching.replaying).toBe(true);
    expect(isComposerLive({ status: attaching.status, pendingSend: false })).toBe(true);

    useWorkbenchStore.getState().applyEvents(RUN);
    const replayed = useWorkbenchStore.getState();
    expect(replayed.status).toBe('running');
    const live = isComposerLive({ status: replayed.status, pendingSend: false });
    expect(live).toBe(true);
    expect(live ? 'interruptPlaceholder' : 'continuePlaceholder').toBe('interruptPlaceholder');
    // The streaming reply, the running tool card and the in-flight markers are
    // all back where they were.
    expect(replayed.chat.some((node) => node.kind === 'assistant')).toBe(true);
    expect(replayed.chat.some((node) => node.kind === 'tool' && node.toolState === 'running')).toBe(
      true,
    );
    expect(replayed.generatingOrder).toBe(1);
    expect(replayed.pages[1]?.sceneId).toBe('scene-1');
    expect(shouldShowWorkbenchEmptyState({ chat: replayed.chat, catchingUp: false, live })).toBe(
      false,
    );
  });

  it('a re-attach to the SAME session keeps its fold', () => {
    useWorkbenchStore.getState().detach();
    driveARunningSession();
    const before = useWorkbenchStore.getState().chat.length;
    useWorkbenchStore.getState().attach('session-1', null);
    const after = useWorkbenchStore.getState();
    expect(after.chat).toHaveLength(before);
    expect(after.stageId).toBe('stage-a');
    expect(after.status).toBe('running');
  });
});

describe('arriving on ?course= with no conversation at all', () => {
  it('is the same clean start: empty state, SEND, no run', () => {
    // The store has never been attached (a user with no conversations opening a
    // classroom). This path shared the bug: the initial `connecting` made it live
    // too, so the composer showed STOP and the empty state was suppressed on a
    // brand-new page.
    useWorkbenchStore.getState().detach();
    const { status, chat, sessionId } = useWorkbenchStore.getState();
    expect(sessionId).toBeNull();
    const live = isComposerLive({ status, pendingSend: false });
    expect(live).toBe(false);
    expect(shouldShowWorkbenchEmptyState({ chat, catchingUp: false, live })).toBe(true);
  });
});
