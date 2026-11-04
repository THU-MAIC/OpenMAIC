import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetSceneWrites,
  noteScenesWritten,
  reconcileFetchedScenes,
} from '@/lib/edit/scene-echo';
import { mergeFetchedScenes } from '@/lib/workbench/stage-freshness';
import type { Scene } from '@/lib/types/stage';

function scene(
  id: string,
  questions: unknown[] = [],
  overrides: Record<string, unknown> = {},
): Scene {
  return {
    id,
    stageId: 's',
    type: 'quiz',
    title: id,
    order: 1,
    content: { type: 'quiz', questions },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as Scene;
}

const clean = {
  stageId: 's',
  removedIds: [] as string[],
  addedIds: [] as string[],
  isSceneDirty: () => false,
  structureDirty: false,
  now: 1_000_000,
};

beforeEach(() => forgetSceneWrites('s'));

describe('reconcileFetchedScenes', () => {
  function slideWith(html: string) {
    return scene('a', [], {
      type: 'slide',
      content: {
        type: 'slide',
        schemaVersion: 1,
        canvas: { id: 'c', elements: [{ id: 't', type: 'text', content: html }] },
      },
    });
  }

  it('recognises its own save read back through the server sanitizer', () => {
    const written = slideWith('<p style="">typed</p>');
    const shown = slideWith('<p>before</p>');
    noteScenesWritten('s', [written], clean.now - 1_000);
    const result = reconcileFetchedScenes({
      ...clean,
      current: [shown],
      fetched: [slideWith('<p>typed</p>')],
      isSceneDirty: () => true,
    });
    expect(result.fetched[0]).toBe(shown);
    expect(result.deferredIds.has('a')).toBe(true);
  });

  it('treats what is shown and its sanitized copy as the same, however late the read', () => {
    const shown = slideWith('<p style="">typed</p>');
    const result = reconcileFetchedScenes({
      ...clean,
      current: [shown],
      fetched: [slideWith('<p>typed</p>')],
    });
    expect(result.fetched[0]).toBe(shown);
    expect(result.deferredIds.size).toBe(0);
  });

  it('treats a copy equal to what is shown as an echo: same object, even with undefined members', () => {
    const local = scene('a', [{ id: 1, clip: undefined }]);
    const server = { ...scene('a', [{ id: 1 }]), updatedAt: 500 } as Scene;
    const result = reconcileFetchedScenes({ ...clean, current: [local], fetched: [server] });
    expect(result.fetched[0]).toBe(local);
    expect(result.deferredIds.size).toBe(0);
  });

  it('keeps a newer local edit over an older save read back (dirty)', () => {
    const older = scene('a', ['older']);
    const newer = scene('a', ['newer']);
    noteScenesWritten('s', [older], 900_000);
    const result = reconcileFetchedScenes({
      ...clean,
      current: [newer],
      fetched: [{ ...older }],
      isSceneDirty: () => true,
    });
    expect(result.fetched[0]).toBe(newer);
    expect(result.deferredIds.has('a')).toBe(true);
  });

  it('keeps a newer local edit over an older save read back just after its write landed', () => {
    const older = scene('a', ['older']);
    const newer = scene('a', ['newer']);
    noteScenesWritten('s', [older, newer], clean.now - 1_000);
    const result = reconcileFetchedScenes({ ...clean, current: [newer], fetched: [{ ...older }] });
    expect(result.fetched[0]).toBe(newer);
    expect(result.deferredIds.has('a')).toBe(true);
  });

  it('takes the copy once no write explains it: the server really holds it', () => {
    const older = scene('a', ['older']);
    const newer = scene('a', ['newer']);
    noteScenesWritten('s', [older], clean.now - 60_000);
    const result = reconcileFetchedScenes({ ...clean, current: [newer], fetched: [{ ...older }] });
    expect(result.fetched[0].content).toEqual(older.content);
    expect(result.deferredIds.size).toBe(0);
  });

  it('takes an unknown copy as a real change, even over an unsaved local edit', () => {
    const local = scene('a', ['local']);
    const agent = scene('a', ['agent']);
    const result = reconcileFetchedScenes({
      ...clean,
      current: [local],
      fetched: [agent],
      isSceneDirty: () => true,
    });
    expect(result.fetched[0].content).toEqual(agent.content);
  });

  it('decides per field: the agent title lands, the local content stays', () => {
    const older = scene('a', ['older']);
    const local = scene('a', ['newer']);
    noteScenesWritten('s', [older], clean.now - 1_000);
    const server = { ...older, title: 'Agent title' } as Scene;
    const result = reconcileFetchedScenes({
      ...clean,
      current: [local],
      fetched: [server],
      isSceneDirty: () => true,
    });
    expect(result.fetched[0]).toMatchObject({ title: 'Agent title', content: local.content });
  });

  it('does not bring back a page deleted here while that deletion is unsaved', () => {
    const result = reconcileFetchedScenes({
      ...clean,
      current: [scene('b')],
      fetched: [scene('a')],
      structureDirty: true,
    });
    expect(result.fetched).toEqual([]);
    expect(result.deferredIds.has('a')).toBe(true);
  });

  it('takes a page new to the server as an agent addition', () => {
    const result = reconcileFetchedScenes({
      ...clean,
      current: [scene('b')],
      fetched: [scene('n')],
      addedIds: ['n'],
      structureDirty: true,
    });
    expect(result.fetched.map((s) => s.id)).toEqual(['n']);
  });

  it('does not bring back a page we wrote and then removed locally', () => {
    const page = scene('n');
    noteScenesWritten('s', [page], clean.now - 500);
    const result = reconcileFetchedScenes({
      ...clean,
      current: [],
      fetched: [{ ...page }],
      addedIds: ['n'],
    });
    expect(result.fetched).toEqual([]);
  });

  it('keeps a restored page when the server still lacks it, defers, then accepts a real removal', () => {
    const page = scene('a');
    const kept = reconcileFetchedScenes({
      ...clean,
      current: [page],
      fetched: [],
      removedIds: ['a'],
      structureDirty: true,
    });
    expect(kept.removedIds).toEqual([]);
    expect(kept.deferredIds.has('a')).toBe(true);
    const removed = reconcileFetchedScenes({
      ...clean,
      current: [page],
      fetched: [],
      removedIds: ['a'],
    });
    expect(removed.removedIds).toEqual(['a']);
  });

  it('keeps the local page order while a move is unsaved', () => {
    const local = scene('a', [], { order: 5 });
    const server = scene('a', [], { order: 2 });
    const dirty = reconcileFetchedScenes({
      ...clean,
      current: [local],
      fetched: [server],
      structureDirty: true,
    });
    expect(dirty.fetched[0]).toBe(local);
    const settled = reconcileFetchedScenes({ ...clean, current: [local], fetched: [server] });
    expect(settled.fetched[0].order).toBe(2);
  });

  it('merges to no change for a pure echo', () => {
    const local = scene('a', ['x']);
    const reconciled = reconcileFetchedScenes({
      ...clean,
      current: [local],
      fetched: [{ ...local }],
    });
    const merge = mergeFetchedScenes({
      current: [local],
      fetched: reconciled.fetched,
      removedIds: reconciled.removedIds,
    });
    expect(merge.changed).toBe(false);
  });

  it('shows why this exists: the plain merge lets an older save replace a newer edit', () => {
    const merge = mergeFetchedScenes({
      current: [scene('a', ['newer'])],
      fetched: [scene('a', ['older'])],
      removedIds: [],
    });
    expect(merge.scenes[0].content).toEqual({ type: 'quiz', questions: ['older'] });
  });
});
