import { describe, expect, it, beforeEach, vi } from 'vitest';

import { useRegenSnapshots } from '@/lib/agent/client/regen-snapshots';
import type { SceneContent } from '@/lib/types/stage';

const SNAP = {
  sceneId: 's1',
  content: { type: 'slide', canvas: { id: 'c', elements: [] } } as unknown as SceneContent,
  actions: [{ type: 'speech', id: 'a_old' } as never],
  // post-edit state, so an undo can be resumed (redo)
  redo: {
    content: { type: 'slide', canvas: { id: 'c', elements: [{ id: 'e' }] } } as unknown as SceneContent,
    actions: [{ type: 'speech', id: 'a_new' } as never],
  },
};

describe('regen-snapshots store', () => {
  beforeEach(() => {
    useRegenSnapshots.setState({ snapshots: {} });
  });

  it('stores a snapshot keyed by toolCallId (not yet restored)', () => {
    useRegenSnapshots.getState().setSnapshot('call-1', SNAP);
    const s = useRegenSnapshots.getState().snapshots['call-1'];
    expect(s.sceneId).toBe('s1');
    expect(s.restored).toBe(false);
  });

  it('restore toggles: undo applies the pre-edit snapshot, resume re-applies the post-edit (redo)', () => {
    const apply = vi.fn();
    useRegenSnapshots.getState().setSnapshot('call-1', SNAP);

    // First click = undo → pre-edit state.
    useRegenSnapshots.getState().restore('call-1', apply);
    expect(apply).toHaveBeenNthCalledWith(1, 's1', { content: SNAP.content, actions: SNAP.actions });
    expect(useRegenSnapshots.getState().snapshots['call-1'].restored).toBe(true);

    // Second click = resume (redo) → post-edit state, toggles back.
    useRegenSnapshots.getState().restore('call-1', apply);
    expect(apply).toHaveBeenNthCalledWith(2, 's1', {
      content: SNAP.redo.content,
      actions: SNAP.redo.actions,
    });
    expect(useRegenSnapshots.getState().snapshots['call-1'].restored).toBe(false);

    // Third click = undo again.
    useRegenSnapshots.getState().restore('call-1', apply);
    expect(apply).toHaveBeenCalledTimes(3);
    expect(useRegenSnapshots.getState().snapshots['call-1'].restored).toBe(true);
  });

  it('restored snapshot without redo data cannot resume (stays restored)', () => {
    const apply = vi.fn();
    const { redo: _redo, ...noRedo } = SNAP;
    useRegenSnapshots.getState().setSnapshot('call-1', noRedo);
    useRegenSnapshots.getState().restore('call-1', apply); // undo
    useRegenSnapshots.getState().restore('call-1', apply); // no redo → no-op
    expect(apply).toHaveBeenCalledTimes(1);
    expect(useRegenSnapshots.getState().snapshots['call-1'].restored).toBe(true);
  });

  it('restore is a no-op for an unknown toolCallId', () => {
    const apply = vi.fn();
    useRegenSnapshots.getState().restore('missing', apply);
    expect(apply).not.toHaveBeenCalled();
  });

  it('actionsOnly snapshot restores actions only (never reverts slide content)', () => {
    const apply = vi.fn();
    useRegenSnapshots.getState().setSnapshot('call-1', { ...SNAP, actionsOnly: true });
    useRegenSnapshots.getState().restore('call-1', apply);
    expect(apply).toHaveBeenCalledWith('s1', { actions: SNAP.actions });
    // crucially, the patch must NOT carry content (would clobber later edits)
    expect(apply.mock.calls[0][1]).not.toHaveProperty('content');
  });

  it('clearAll drops every snapshot', () => {
    useRegenSnapshots.getState().setSnapshot('call-1', SNAP);
    useRegenSnapshots.getState().setSnapshot('call-2', SNAP);
    useRegenSnapshots.getState().clearAll();
    expect(useRegenSnapshots.getState().snapshots).toEqual({});
  });
});
