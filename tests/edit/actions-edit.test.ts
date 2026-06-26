import { describe, expect, test } from 'vitest';
import {
  appendDiscussion,
  clampInsertSlot,
  discussionIndex,
  hasDiscussion,
  insertAt,
  makeAction,
  makeDiscussion,
  move,
  moveById,
  moveByIdDir,
  removeAt,
  removeById,
  setAudioId,
  setAudioIdById,
  setDiscussionAgentById,
  setDiscussionPromptById,
  setDiscussionTopicById,
  setElementId,
  setElementIdById,
  setSpeechText,
  setSpeechTextById,
  setSpeechTextClearAudioById,
} from '@/components/edit/ActionsBar/actions-edit';
import type { Action } from '@/lib/types/action';

const A = (id: string, type = 'speech'): Action => ({ id, type }) as unknown as Action;
const ids = (xs: Action[]) => xs.map((a) => a.id);

describe('makeAction', () => {
  test('speech carries empty text; element cues carry empty elementId', () => {
    expect(makeAction('speech', 's')).toEqual({ id: 's', type: 'speech', text: '' });
    expect(makeAction('spotlight', 'p')).toEqual({ id: 'p', type: 'spotlight', elementId: '' });
    expect(makeAction('laser', 'l')).toEqual({ id: 'l', type: 'laser', elementId: '' });
  });
});

describe('insertAt / removeAt', () => {
  const base = [A('a'), A('b'), A('c')];
  test('inserts at the slot and clamps out-of-range', () => {
    expect(ids(insertAt(base, 1, A('x')))).toEqual(['a', 'x', 'b', 'c']);
    expect(ids(insertAt(base, 99, A('x')))).toEqual(['a', 'b', 'c', 'x']);
    expect(ids(insertAt(base, -5, A('x')))).toEqual(['x', 'a', 'b', 'c']);
  });
  test('does not mutate the input', () => {
    insertAt(base, 1, A('x'));
    expect(ids(base)).toEqual(['a', 'b', 'c']);
  });
  test('removeAt drops the index; no-op when out of range', () => {
    expect(ids(removeAt(base, 1))).toEqual(['a', 'c']);
    expect(ids(removeAt(base, 9))).toEqual(['a', 'b', 'c']);
  });
});

describe('move', () => {
  const base = [A('a'), A('b'), A('c'), A('d')];
  test('moves forward (slot is an original-array gap)', () => {
    expect(ids(move(base, 0, 2))).toEqual(['b', 'a', 'c', 'd']);
    expect(ids(move(base, 0, 4))).toEqual(['b', 'c', 'd', 'a']);
  });
  test('moves backward', () => {
    expect(ids(move(base, 3, 1))).toEqual(['a', 'd', 'b', 'c']);
  });
  test('no-op when dropping into its own slot', () => {
    expect(ids(move(base, 1, 1))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(move(base, 1, 2))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('by-id ops (index-stale-safe)', () => {
  const base = [A('a'), A('b'), A('c'), A('d')];
  test('moveById targets the slot; missing id is a no-op', () => {
    expect(ids(moveById(base, 'a', 2))).toEqual(['b', 'a', 'c', 'd']);
    expect(moveById(base, 'zzz', 2)).toBe(base);
  });
  test('moveByIdDir nudges left/right by one and clamps at the ends', () => {
    expect(ids(moveByIdDir(base, 'c', -1))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(moveByIdDir(base, 'b', 1))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(moveByIdDir(base, 'a', -1))).toEqual(['a', 'b', 'c', 'd']); // already first
    expect(ids(moveByIdDir(base, 'd', 1))).toEqual(['a', 'b', 'c', 'd']); // already last
  });
  test('removeById / setSpeechTextById resolve by id', () => {
    expect(ids(removeById(base, 'c'))).toEqual(['a', 'b', 'd']);
    expect(removeById(base, 'zzz')).toBe(base);
    const xs = [A('s', 'speech')];
    expect((setSpeechTextById(xs, 's', 'hi')[0] as { text?: string }).text).toBe('hi');
    expect(setSpeechTextById(xs, 'zzz', 'no')).toBe(xs);
  });
});

describe('discussion ops (append-only, terminal, at most one)', () => {
  const disc = (id: string, extra: Record<string, unknown> = {}): Action =>
    ({ id, type: 'discussion', topic: '', ...extra }) as unknown as Action;

  test('makeDiscussion carries an empty topic', () => {
    expect(makeDiscussion('d')).toEqual({ id: 'd', type: 'discussion', topic: '' });
  });

  test('appendDiscussion adds a discussion at the very end', () => {
    const base = [A('a'), A('b')];
    const out = appendDiscussion(base, 'd');
    expect(ids(out)).toEqual(['a', 'b', 'd']);
    expect(out[2]).toEqual({ id: 'd', type: 'discussion', topic: '' });
  });

  test('appendDiscussion is a no-op when one already exists (at most one)', () => {
    const base = [A('a'), disc('d', { topic: 'x' })];
    expect(appendDiscussion(base, 'd2')).toBe(base);
  });

  test('hasDiscussion / discussionIndex locate the discussion', () => {
    const base = [A('a'), disc('d')];
    expect(hasDiscussion(base)).toBe(true);
    expect(discussionIndex(base)).toBe(1);
    expect(hasDiscussion([A('a')])).toBe(false);
    expect(discussionIndex([A('a')])).toBe(-1);
  });

  test('clampInsertSlot caps inserts before the discussion (keeps it terminal)', () => {
    const base = [A('a'), A('b'), disc('d')];
    expect(clampInsertSlot(base, 3)).toBe(2); // can't land after the discussion
    expect(clampInsertSlot(base, 2)).toBe(2); // right before it is the cap
    expect(clampInsertSlot(base, 1)).toBe(1); // earlier slots untouched
    expect(clampInsertSlot([A('a'), A('b')], 2)).toBe(2); // no discussion → unchanged
  });

  test('setDiscussionTopicById sets topic; missing id / non-discussion are no-ops', () => {
    const xs = [disc('d', { topic: 'old' }), A('a')];
    expect((setDiscussionTopicById(xs, 'd', 'new')[0] as { topic?: string }).topic).toBe('new');
    expect(setDiscussionTopicById(xs, 'zzz', 'x')).toBe(xs);
    expect(setDiscussionTopicById(xs, 'a', 'x')).toBe(xs); // 'a' is not a discussion
  });

  test('setDiscussionPromptById sets prompt; empty string clears it', () => {
    const xs = [disc('d')];
    const withPrompt = setDiscussionPromptById(xs, 'd', 'guide');
    expect((withPrompt[0] as { prompt?: string }).prompt).toBe('guide');
    expect(
      (setDiscussionPromptById(withPrompt, 'd', '')[0] as { prompt?: string }).prompt,
    ).toBeUndefined();
    expect(setDiscussionPromptById(xs, 'missing', 'x')).toBe(xs);
  });

  test('setDiscussionAgentById sets agentId; empty string clears it', () => {
    const xs = [disc('d')];
    const withAgent = setDiscussionAgentById(xs, 'd', 'agent_1');
    expect((withAgent[0] as { agentId?: string }).agentId).toBe('agent_1');
    expect(
      (setDiscussionAgentById(withAgent, 'd', '')[0] as { agentId?: string }).agentId,
    ).toBeUndefined();
    expect(setDiscussionAgentById(xs, 'missing', 'x')).toBe(xs);
  });
});

describe('setSpeechText / setElementId', () => {
  test('setSpeechText only edits speech actions', () => {
    const xs = [A('a', 'speech'), A('b', 'spotlight')];
    expect((setSpeechText(xs, 0, 'hi')[0] as { text?: string }).text).toBe('hi');
    expect(setSpeechText(xs, 1, 'no')).toBe(xs); // unchanged reference (no-op)
  });
  test('setElementId only targets element-bound cues, not speech', () => {
    const xs = [A('a', 'spotlight'), A('b', 'speech')];
    expect((setElementId(xs, 0, 'el_1')[0] as { elementId?: string }).elementId).toBe('el_1');
    expect(setElementId(xs, 1, 'el_x')).toBe(xs); // no-op: speech is not element-bound
  });
  test('setElementIdById / setAudioIdById target by id (index-stale-safe)', () => {
    const xs = [A('a', 'spotlight'), A('b', 'speech')];
    expect((setElementIdById(xs, 'a', 'el_1')[0] as { elementId?: string }).elementId).toBe('el_1');
    expect(setElementIdById(xs, 'missing', 'x')).toBe(xs);
    expect((setAudioIdById(xs, 'b', 'tts_b')[1] as { audioId?: string }).audioId).toBe('tts_b');
    expect(setAudioIdById(xs, 'a', 'tts_a')).toBe(xs); // 'a' is not speech → no-op
  });
  test('setAudioId only stamps speech actions', () => {
    const xs = [A('a', 'speech'), A('b', 'spotlight')];
    expect((setAudioId(xs, 0, 'tts_a')[0] as { audioId?: string }).audioId).toBe('tts_a');
    expect(setAudioId(xs, 1, 'tts_b')).toBe(xs); // no-op for non-speech
  });
  test('setSpeechTextClearAudioById sets text and drops stale audio fields', () => {
    const xs: Action[] = [
      { id: 'a', type: 'speech', text: 'old', audioId: 'tts_a', audioUrl: 'blob:x' } as Action,
      A('b', 'spotlight'),
    ];
    const out = setSpeechTextClearAudioById(xs, 'a', 'new') as Array<{
      text?: string;
      audioId?: string;
      audioUrl?: string;
    }>;
    expect(out[0].text).toBe('new');
    expect(out[0].audioId).toBeUndefined();
    expect(out[0].audioUrl).toBeUndefined();
    // index-stale-safe + type guard: missing id and non-speech are no-ops
    expect(setSpeechTextClearAudioById(xs, 'missing', 'x')).toBe(xs);
    expect(setSpeechTextClearAudioById(xs, 'b', 'x')).toBe(xs);
  });
});
