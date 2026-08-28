/**
 * What a conversation is called, and what renaming it does.
 *
 * The title has two possible sources — the name the user gave it, and the first
 * message it derives from otherwise — and two surfaces that must never disagree
 * about which is showing (the pane header and the rail row). Both read the
 * derivation here; both write through `commitSessionRename`.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  commitSessionRename,
  isDerivedSessionTitle,
  normalizeSessionTitleInput,
  SESSION_TITLE_MAX_LENGTH,
  workbenchSessionTitle,
} from '@/lib/workbench/session-title';
import { foldEvents, type WorkbenchEvent, type WorkbenchFold } from '@/lib/workbench/session-store';

describe('what a conversation is called', () => {
  it('prefers the name the user gave it', () => {
    expect(workbenchSessionTitle({ title: '期末复习课', prompt: '帮我做一节课' })).toBe(
      '期末复习课',
    );
  });

  it('derives it from the first message when there is no name', () => {
    expect(workbenchSessionTitle({ title: null, prompt: '帮我做一节课' })).toBe('帮我做一节课');
    expect(workbenchSessionTitle({ title: '   ', prompt: '帮我做一节课' })).toBe('帮我做一节课');
  });

  it('has nothing to show for an empty conversation', () => {
    // The caller supplies its own placeholder — the rail says "untitled chat", the
    // pane header says "new chat", because they answer different questions.
    expect(workbenchSessionTitle({ title: null, prompt: '' })).toBeNull();
    expect(workbenchSessionTitle({})).toBeNull();
  });
});

describe('what a rename sends', () => {
  const session = { title: '期末复习课', prompt: '帮我做一节课' };

  it('trims and caps', () => {
    expect(normalizeSessionTitleInput(session, '  新名字  ')).toBe('新名字');
    expect(normalizeSessionTitleInput(session, 'x'.repeat(400))).toHaveLength(
      SESSION_TITLE_MAX_LENGTH,
    );
  });

  it('reads an empty box as "clear the name", not as a blank title', () => {
    expect(normalizeSessionTitleInput(session, '')).toBeNull();
    expect(normalizeSessionTitleInput(session, '   ')).toBeNull();
  });

  it('reads the derived title typed back in as a clear too', () => {
    // Storing it would freeze a name the user never chose.
    expect(isDerivedSessionTitle(session, '帮我做一节课')).toBe(true);
    expect(normalizeSessionTitleInput(session, ' 帮我做一节课 ')).toBeNull();
  });
});

describe('committing a rename', () => {
  const session = { title: null, prompt: '帮我做一节课' };

  it('writes it locally first, then settles on what the server stored', async () => {
    const applied: (string | null)[] = [];
    const save = vi.fn(async () => '期末复习');
    const outcome = await commitSessionRename({
      current: session,
      raw: '期末复习课',
      apply: (title) => applied.push(title),
      save,
    });
    expect(outcome).toBe('renamed');
    expect(save).toHaveBeenCalledWith('期末复习课');
    // Optimistic value, then the server's — which can differ (it caps).
    expect(applied).toEqual(['期末复习课', '期末复习']);
  });

  it('puts the old name back when the write is refused', async () => {
    const applied: (string | null)[] = [];
    const outcome = await commitSessionRename({
      current: { title: '旧名字', prompt: '帮我做一节课' },
      raw: '新名字',
      apply: (title) => applied.push(title),
      save: async () => {
        throw new Error('500');
      },
    });
    expect(outcome).toBe('failed');
    expect(applied).toEqual(['新名字', '旧名字']);
  });

  it('clears the override on an empty box, so the derived title comes back', async () => {
    const applied: (string | null)[] = [];
    const save = vi.fn(async () => null);
    const outcome = await commitSessionRename({
      current: { title: '旧名字', prompt: '帮我做一节课' },
      raw: '  ',
      apply: (title) => applied.push(title),
      save,
    });
    expect(outcome).toBe('renamed');
    expect(save).toHaveBeenCalledWith(null);
    expect(applied).toEqual([null, null]);
  });

  it('spends no round trip when nothing changed', async () => {
    const save = vi.fn(async () => null);
    const outcome = await commitSessionRename({
      current: { title: '旧名字', prompt: '帮我做一节课' },
      raw: ' 旧名字 ',
      apply: () => expect.unreachable('nothing should be written'),
      save,
    });
    expect(outcome).toBe('unchanged');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('the fold leaves the name alone', () => {
  /**
   * A rename is not something the run did, so it is NOT in the event log: it
   * arrives with the session meta, like the prompt. Replaying the whole log —
   * which is what a reconnect and a fresh attach both do — must therefore leave
   * it standing, or a renamed chat would revert to its first message every time
   * the stream caught up.
   */
  it('survives a replay of the whole event log', () => {
    const named = { ...BLANK, sessionPrompt: '帮我做一节课', sessionTitle: '期末复习课' };
    const replayed = foldEvents(named, [
      event('session_start', { prompt: '帮我做一节课' }),
      event('message_update', { text: '好的' }),
      event('session_end', { status: 'succeeded' }),
    ]);
    expect(replayed.sessionTitle).toBe('期末复习课');
    expect(
      workbenchSessionTitle({ title: replayed.sessionTitle, prompt: replayed.sessionPrompt }),
    ).toBe('期末复习课');
  });
});

let seq = 0;
function event(type: string, data: unknown): WorkbenchEvent {
  seq += 1;
  return { id: seq, ts: 1000 + seq, attempt: 1, type, data };
}

const BLANK: WorkbenchFold = {
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
