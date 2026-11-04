import { describe, expect, it } from 'vitest';
import {
  ASSET_RETENTION_MS,
  EMPTY_LINE,
  MAX_TIMELINE_STEPS,
  AGENT_RUN_SETTLE_MS,
  applyTimelineEntry,
  composeEntries,
  diffCourse,
  expireSteps,
  noteDocumentRefs,
  normalizedJson,
  pushEntry,
  restorePageOrder,
  stepLine,
  useCourseTimeline,
  type CourseDocument,
  type CourseLine,
  type TimelineEntry,
} from '@/lib/edit/course-timeline';
import type { Scene, Stage } from '@/lib/types/stage';

const stage = { id: 'stage-1', name: 'Course' } as unknown as Stage;

function scene(id: string, overrides: Record<string, unknown> = {}): Scene {
  return {
    id,
    stageId: stage.id,
    type: 'quiz',
    title: id,
    order: 1,
    content: { type: 'quiz', questions: [] },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as Scene;
}

function doc(
  scenes: Scene[],
  currentSceneId: string | null = scenes[0]?.id ?? null,
): CourseDocument {
  return { stage, scenes, currentSceneId };
}

function step(before: CourseDocument, after: CourseDocument, extra = {}): TimelineEntry {
  const entry = diffCourse(before, after, { origin: 'user', at: 1000, ...extra });
  if (!entry) throw new Error('expected a change');
  return entry;
}

function imageSlide(id: string, src: string): Scene {
  return scene(id, {
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `c-${id}`,
        elements: [{ id: 'i', type: 'image', src, left: 0, top: 0, width: 1, height: 1 }],
      },
    },
  });
}

describe('diffCourse', () => {
  it('holds only the fields that changed', () => {
    const entry = step(doc([scene('a')]), doc([scene('a', { title: 'New' })]));
    expect(entry.scenes.a).toEqual({ before: { title: 'a' }, after: { title: 'New' } });
    expect(entry.order).toBeNull();
  });

  it('sees no change in a copy differing only by undefined members or key order', () => {
    const before = scene('a', { content: { type: 'quiz', questions: [], clip: undefined } });
    const after = scene('a', { content: { questions: [], type: 'quiz' }, updatedAt: 99 });
    expect(diffCourse(doc([before]), doc([after]), { origin: 'user', at: 1 })).toBeNull();
    expect(normalizedJson({ b: 1, a: undefined, c: { y: 1, x: 2 } })).toBe(
      '{"b":1,"c":{"x":2,"y":1}}',
    );
  });

  it('does not treat a renumbered page or a focus change as a step', () => {
    const before = doc([scene('a'), scene('b')], 'a');
    const after = doc([scene('a', { order: 7 }), scene('b', { order: 8 })], 'b');
    expect(diffCourse(before, after, { origin: 'user', at: 1 })).toBeNull();
  });

  it('holds an added or removed page whole, with the order on both sides', () => {
    const removed = step(doc([scene('a'), scene('b')]), doc([scene('a')]));
    expect(removed.scenes.b.after).toBeNull();
    expect(removed.scenes.b.before).toMatchObject({ id: 'b', content: { type: 'quiz' } });
    expect(removed.order).toEqual({ before: ['a', 'b'], after: ['a'] });
  });

  it('records a video manifest move', () => {
    const before = {
      ...doc([scene('a')]),
      stage: { ...stage, videoManifest: { v: {} } } as unknown as Stage,
    };
    const after = { ...doc([scene('a')]), stage: { ...stage, videoManifest: {} } as Stage };
    expect(step(before, after).videoManifest).toEqual({ before: { v: {} }, after: {} });
  });
});

describe('applyTimelineEntry', () => {
  it('touches only what the entry changed', () => {
    const entry = step(doc([scene('a', { title: 'old' })]), doc([scene('a', { title: 'new' })]));
    const later = scene('a', { title: 'new', actions: [{ id: 'later', type: 'speech' }] });
    const applied = applyTimelineEntry(doc([later]), entry, 'undo')!;
    expect(applied.scenes[0]).toMatchObject({ title: 'old', actions: [{ id: 'later' }] });
    expect(applied.changedSceneIds).toEqual(['a']);
    expect(applied.structureChanged).toBe(false);
  });

  it('restores a deleted page in place with its id, rebalanced', () => {
    const b = scene('b', { title: 'keep me' });
    const before = doc([scene('a'), b, scene('c')], 'c');
    const entry = step(before, doc([scene('a'), scene('c')], 'c'));
    const applied = applyTimelineEntry(doc([scene('a'), scene('c')], 'c'), entry, 'undo')!;
    expect(applied.scenes.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(applied.scenes.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(applied.scenes[1].title).toBe('keep me');
    expect(applied.currentSceneId).toBe('b');
    expect(applied.structureChanged).toBe(true);
  });

  it('jumps to the page an edit belongs to, and lands on a neighbour after redoing a deletion', () => {
    const before = doc([scene('a'), scene('b', { title: 'x' }), scene('c')], 'b');
    const edited = doc([scene('a'), scene('b', { title: 'y' }), scene('c')], 'b');
    const entry = step(before, edited);
    expect(
      applyTimelineEntry({ ...edited, currentSceneId: 'c' }, entry, 'undo')!.currentSceneId,
    ).toBe('b');
    const deletion = step(doc([scene('a'), scene('b')], 'b'), doc([scene('a')], 'a'));
    const redone = applyTimelineEntry(doc([scene('a'), scene('b')], 'b'), deletion, 'redo')!;
    expect(redone.scenes.map((s) => s.id)).toEqual(['a']);
    expect(redone.currentSceneId).toBe('a');
  });

  it('skips a patch for a page that no longer exists, and reports nothing changed', () => {
    const entry = step(doc([scene('a', { title: 'x' })]), doc([scene('a', { title: 'y' })]));
    expect(applyTimelineEntry(doc([scene('other')]), entry, 'undo')).toBeNull();
  });

  it('moves only the manifest keys the entry moved', () => {
    const entry = step(
      { ...doc([scene('a')]), stage: { ...stage, videoManifest: { old: {} } } as unknown as Stage },
      { ...doc([scene('a')]), stage: { ...stage, videoManifest: {} } as unknown as Stage },
    );
    const applied = applyTimelineEntry(
      {
        ...doc([scene('a')]),
        stage: { ...stage, videoManifest: { added: {} } } as unknown as Stage,
      },
      entry,
      'undo',
    )!;
    expect(applied.stage?.videoManifest).toEqual({ old: {}, added: {} });
    expect(applied.stageChanged).toBe(true);
  });
});

describe('applyTimelineEntry on the manifest', () => {
  it('removes only a key the entry added when undoing', () => {
    const withManifest = (videoManifest: unknown) => ({
      ...doc([scene('a')]),
      stage: { ...stage, videoManifest } as unknown as Stage,
    });
    const entry = step(withManifest({}), withManifest({ added: {} }));
    const applied = applyTimelineEntry(withManifest({ added: {}, other: {} }), entry, 'undo')!;
    expect(applied.stage?.videoManifest).toEqual({ other: {} });
  });
});

describe('restorePageOrder', () => {
  it('drops ids that are gone and keeps unknown ids in place', () => {
    expect(restorePageOrder(['a', 'x', 'b', 'c'], ['c', 'gone', 'b', 'a'])).toEqual([
      'c',
      'x',
      'b',
      'a',
    ]);
    expect(restorePageOrder(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a']);
    expect(restorePageOrder(['x'], ['a'])).toEqual(['x']);
  });
});

const titled = (from: string, to: string, extra = {}) =>
  step(doc([scene('a', { title: from })]), doc([scene('a', { title: to })]), extra);

describe('the line', () => {
  it('caps at 100 steps, dropping the oldest', () => {
    let line: CourseLine = EMPTY_LINE;
    for (let index = 0; index < MAX_TIMELINE_STEPS + 5; index += 1) {
      line = pushEntry(line, titled(`t${index}`, `t${index + 1}`));
    }
    expect(line.past).toHaveLength(MAX_TIMELINE_STEPS);
    expect(line.past[0].scenes.a.before).toEqual({ title: 't5' });
  });

  it('clears redo on a new step', () => {
    let line = pushEntry(EMPTY_LINE, titled('a', 'b'));
    line = stepLine(line, 'undo');
    expect(line.future).toHaveLength(1);
    line = pushEntry(line, titled('a', 'c'));
    expect(line.future).toHaveLength(0);
  });

  it('folds a burst with the same key into one step, and a different key starts another', () => {
    let line = pushEntry(EMPTY_LINE, titled('a', 'b', { coalesceKey: 'k' }));
    line = pushEntry(line, titled('b', 'c', { coalesceKey: 'k' }));
    expect(line.past).toHaveLength(1);
    expect(line.past[0].scenes.a).toEqual({ before: { title: 'a' }, after: { title: 'c' } });
    line = pushEntry(line, titled('c', 'd', { coalesceKey: 'other' }));
    line = pushEntry(line, titled('d', 'e', { coalesceKey: 'k' }));
    expect(line.past).toHaveLength(3);
  });

  it('does not fold into a burst across an undo', () => {
    let line = pushEntry(EMPTY_LINE, titled('a', 'b', { coalesceKey: 'k' }));
    line = pushEntry(line, titled('b', 'c'));
    line = stepLine(line, 'undo');
    line = pushEntry(line, titled('b', 'd', { coalesceKey: 'k' }));
    expect(line.past).toHaveLength(2);
  });

  it('does not continue an old burst of the same key after undoing back to it', () => {
    let line = pushEntry(EMPTY_LINE, titled('a', 'b', { coalesceKey: 'k' }));
    line = pushEntry(line, titled('b', 'c', { coalesceKey: 'j' }));
    line = pushEntry(line, titled('c', 'd', { coalesceKey: 'k' }));
    line = stepLine(line, 'undo');
    line = stepLine(line, 'undo');
    line = pushEntry(line, titled('b', 'e', { coalesceKey: 'k' }));
    expect(line.past).toHaveLength(2);
    expect(line.past[0].scenes.a.after).toEqual({ title: 'b' });
  });

  it('does not fold into the step below after undoing a burst', () => {
    let line = pushEntry(EMPTY_LINE, titled('a', 'b'));
    line = pushEntry(line, titled('b', 'c', { coalesceKey: 'k' }));
    line = stepLine(line, 'undo');
    line = pushEntry(line, titled('b', 'd', { coalesceKey: 'k' }));
    expect(line.past).toHaveLength(2);
    expect(line.past[0].scenes.a.after).toEqual({ title: 'b' });
  });

  it('removes a burst that ends where it began, and the next edit does not fold below it', () => {
    let line = pushEntry(EMPTY_LINE, titled('x', 'a'));
    line = pushEntry(line, titled('a', 'b', { coalesceKey: 'k' }));
    line = pushEntry(line, titled('b', 'a', { coalesceKey: 'k' }));
    expect(line.past).toHaveLength(1);
    line = pushEntry(line, titled('a', 'c', { coalesceKey: 'k' }));
    expect(line.past).toHaveLength(2);
    expect(line.past[0].scenes.a.after).toEqual({ title: 'a' });
  });

  it('composes page add and remove across a burst', () => {
    const add = step(doc([scene('a')]), doc([scene('a'), scene('n')]));
    const edit = step(doc([scene('a'), scene('n')]), doc([scene('a'), scene('n', { title: 'T' })]));
    const addEdit = composeEntries(add, edit)!;
    expect(addEdit.scenes.n).toMatchObject({ before: null, after: { id: 'n', title: 'T' } });
    const remove = step(doc([scene('a'), scene('n', { title: 'T' })]), doc([scene('a')]));
    expect(composeEntries(addEdit, remove)).toBeNull();
    const patched = titled('x', 'y');
    const gone = step(doc([scene('a', { title: 'y' })]), doc([scene('b')]));
    expect(composeEntries(patched, gone)!.scenes.a.before).toMatchObject({ id: 'a', title: 'x' });
  });
});

describe('agent runs', () => {
  it('folds a run into one step, split by a hand edit in between', () => {
    let line = pushEntry(EMPTY_LINE, titled('a', 'b', { origin: 'agent', runId: 1 }));
    line = pushEntry(line, titled('b', 'c', { origin: 'agent', runId: 1 }));
    expect(line.past).toHaveLength(1);
    line = pushEntry(line, titled('c', 'd'));
    line = pushEntry(line, titled('d', 'e', { origin: 'agent', runId: 1 }));
    expect(line.past).toHaveLength(3);
    line = pushEntry(line, titled('e', 'f', { origin: 'agent', runId: 2 }));
    expect(line.past).toHaveLength(4);
  });

  it('undo during an open run closes the group: later changes form a new step', () => {
    let line = pushEntry(EMPTY_LINE, titled('a', 'b', { origin: 'agent', runId: 1 }));
    line = stepLine(line, 'undo');
    line = stepLine(line, 'redo');
    expect(line.past[0].runId).toBeUndefined();
    line = pushEntry(line, titled('b', 'c', { origin: 'agent', runId: 1 }));
    expect(line.past).toHaveLength(2);
  });

  it('keeps a run open until the settle window after agent_end passes', () => {
    const timeline = useCourseTimeline.getState();
    timeline.beginAgentRun(Date.now());
    const id = useCourseTimeline.getState().activeRunId(5);
    expect(id).toBeTypeOf('number');
    useCourseTimeline.getState().beginAgentRun(Date.now());
    expect(useCourseTimeline.getState().activeRunId(5)).toBe(id);
    useCourseTimeline.getState().endAgentRun(100);
    expect(useCourseTimeline.getState().activeRunId(100 + AGENT_RUN_SETTLE_MS - 1)).toBe(id);
    expect(useCourseTimeline.getState().activeRunId(100 + AGENT_RUN_SETTLE_MS)).toBeUndefined();
  });
});

describe('media retention', () => {
  const withImage = doc([imageSlide('a', 'asset-1')]);
  const without = doc([imageSlide('a', 'asset-2')]);

  it('expires a step 45 minutes after the removal, not before', () => {
    const entry = step(withImage, without);
    expect(entry.assetRefs.undo).toEqual(['asset-1']);
    let line = noteDocumentRefs(EMPTY_LINE, new Set(['asset-1']), 0);
    line = pushEntry(line, entry);
    line = noteDocumentRefs(line, new Set(['asset-2']), 5_000);
    const early = expireSteps(line, new Set(['asset-2']), 5_000 + ASSET_RETENTION_MS - 1);
    expect(early.expired).toHaveLength(0);
    const late = expireSteps(line, new Set(['asset-2']), 5_000 + ASSET_RETENTION_MS);
    expect(late.expired).toEqual([entry]);
    expect(late.line.past).toHaveLength(0);
  });

  it('keeps a step whose reference is still in the document, and resets when it returns', () => {
    const entry = step(withImage, without);
    let line = noteDocumentRefs(EMPTY_LINE, new Set(['asset-1']), 0);
    line = pushEntry(line, entry);
    expect(expireSteps(line, new Set(['asset-1']), 10 * ASSET_RETENTION_MS).expired).toHaveLength(
      0,
    );
    line = noteDocumentRefs(line, new Set(['asset-2']), 1);
    line = noteDocumentRefs(line, new Set(['asset-1']), 2);
    expect(line.refDroppedAt['asset-1']).toBeUndefined();
    line = noteDocumentRefs(line, new Set(['asset-2']), ASSET_RETENTION_MS);
    expect(expireSteps(line, new Set(['asset-2']), ASSET_RETENTION_MS + 1).expired).toHaveLength(0);
  });

  it('applies the same clock to redo', () => {
    const entry = step(withImage, without);
    let line = noteDocumentRefs(EMPTY_LINE, new Set(['asset-1']), 0);
    line = pushEntry(line, entry);
    line = noteDocumentRefs(line, new Set(['asset-2']), 1);
    line = stepLine(line, 'undo');
    line = noteDocumentRefs(line, new Set(['asset-1']), 2);
    const late = expireSteps(line, new Set(['asset-1']), 2 + ASSET_RETENTION_MS);
    expect(late.expired).toHaveLength(1);
    expect(late.line.future).toHaveLength(0);
  });

  it('counts narration audio too', () => {
    const before = doc([scene('a', { actions: [{ id: 's', type: 'speech', audioId: 'clip' }] })]);
    const after = doc([scene('a', { actions: [] })]);
    expect(step(before, after).assetRefs.undo).toEqual(['clip']);
  });
});
