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
  normalizeSessionTitleOverride,
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

  it('uses the input maxLength budget without splitting a surrogate pair', () => {
    expect(normalizeSessionTitleOverride(`${'x'.repeat(118)}😀`)).toBe(`${'x'.repeat(118)}😀`);
    expect(normalizeSessionTitleOverride(`${'x'.repeat(119)}😀tail`)).toBe('x'.repeat(119));
  });

  it('makes PostgreSQL-invalid API text safe for storage and projection', () => {
    expect(normalizeSessionTitleOverride(`Safe\ud83d title`)).toBe('Safe� title');
    expect(normalizeSessionTitleOverride(`Safe\u0000 title`)).toBe('Safe� title');
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
    const applied: { title: string | null; settled: boolean }[] = [];
    const save = vi.fn(async () => '期末复习');
    const outcome = await commitSessionRename({
      current: session,
      raw: '期末复习课',
      apply: (title, settled) => applied.push({ title, settled }),
      save,
    });
    expect(outcome).toBe('renamed');
    expect(save).toHaveBeenCalledWith('期末复习课');
    // Optimistic value, then the server's — which can differ (it caps).
    expect(applied).toEqual([
      { title: '期末复习课', settled: false },
      { title: '期末复习', settled: true },
    ]);
  });

  it('puts the old name back when the write is refused', async () => {
    const applied: { title: string | null; settled: boolean }[] = [];
    const outcome = await commitSessionRename({
      current: { title: '旧名字', prompt: '帮我做一节课' },
      raw: '新名字',
      apply: (title, settled) => applied.push({ title, settled }),
      save: async () => {
        throw new Error('500');
      },
    });
    expect(outcome).toBe('failed');
    expect(applied).toEqual([
      { title: '新名字', settled: false },
      { title: '旧名字', settled: true },
    ]);
  });

  it.each([
    { settlement: 'success', save: async () => '服务端名字', outcome: 'renamed' },
    {
      settlement: 'failure',
      save: async () => {
        throw new Error('500');
      },
      outcome: 'failed',
    },
  ])('does not apply a stale $settlement settlement', async ({ save, outcome: expected }) => {
    const applied: (string | null)[] = [];
    let current = true;
    const outcome = await commitSessionRename({
      current: { title: '旧名字', prompt: '帮我做一节课' },
      raw: '本地名字',
      apply: (title) => {
        applied.push(title);
        current = false;
      },
      save,
      isCurrent: () => current,
    });

    expect(outcome).toBe(expected);
    expect(applied).toEqual(['本地名字']);
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

  it('preserves an explicit same-value decision queued behind an ambiguous write', async () => {
    const applied: (string | null)[] = [];
    const save = vi.fn(async () => '旧名字');
    const outcome = await commitSessionRename({
      current: { title: '旧名字', prompt: '帮我做一节课' },
      raw: '旧名字',
      apply: (title) => applied.push(title),
      save,
      forceSave: true,
    });

    expect(outcome).toBe('renamed');
    expect(save).toHaveBeenCalledWith('旧名字');
    expect(applied).toEqual(['旧名字', '旧名字']);
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
