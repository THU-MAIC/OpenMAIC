// Implementation-agnostic contract for `DocumentStore`. Every backend (browser
// today, HTTP later) is proven equivalent by running this same suite against it,
// so a new backend cannot silently diverge from the store's semantics.
//
// Backend-specific behaviours that need to seed raw rows (migrate-on-read,
// forward-compat) live in the backend's own test file, not here.
import { describe, expect, test } from 'vitest';
import { DSL_VERSION } from '@openmaic/dsl';
import type { Scene } from '@openmaic/dsl';
import type { DocumentStore, MaicDocument } from '../src/index.js';

// --- fixtures ---------------------------------------------------------------

// Fixtures are cast through `unknown`: `validateScene` only requires `content.canvas`
// to be an object, so these minimal shapes are valid at the boundary without
// spelling out a full `Slide` (viewportSize / theme / …) the store never inspects.

/** A valid slide scene (passes `validateScene`: id/stageId/title/order + slide content). */
export function slideScene(stageId: string, id: string, order: number, title = id): Scene {
  return {
    id,
    stageId,
    title,
    order,
    type: 'slide',
    content: { type: 'slide', canvas: { id: `canvas-${id}`, elements: [] } },
  } as unknown as Scene;
}

/** A valid quiz scene. */
export function quizScene(stageId: string, id: string, order: number, title = id): Scene {
  return {
    id,
    stageId,
    title,
    order,
    type: 'quiz',
    content: {
      type: 'quiz',
      questions: [{ id: `q-${id}`, type: 'single', question: 'Q?' }],
    },
  } as unknown as Scene;
}

/** A valid document: stage metadata + two scenes + an outline snapshot. */
export function makeDocument(stageId = 'stage-1'): MaicDocument {
  return {
    stage: { id: stageId, name: 'Intro Course', createdAt: 1000, updatedAt: 2000 },
    scenes: [slideScene(stageId, 'scene-a', 0), quizScene(stageId, 'scene-b', 1)],
    outline: { entries: [{ id: 'o1', title: 'Intro' }], generationComplete: true },
  };
}

// --- contract ---------------------------------------------------------------

export function runDocumentStoreContract(name: string, makeStore: () => DocumentStore): void {
  describe(`DocumentStore contract: ${name}`, () => {
    test('round-trips a full document (stage + scenes + outline)', async () => {
      const store = makeStore();
      const doc = makeDocument();
      await store.saveDocument(doc);

      const loaded = await store.loadDocument('stage-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.stage).toMatchObject(doc.stage);
      expect(loaded!.scenes.map((s) => s.id)).toEqual(['scene-a', 'scene-b']);
      expect(loaded!.outline).toEqual(doc.outline);
    });

    test('loadDocument returns null for an unknown stage', async () => {
      const store = makeStore();
      expect(await store.loadDocument('nope')).toBeNull();
    });

    test('scenes come back sorted by order regardless of input order', async () => {
      const store = makeStore();
      const doc = makeDocument('stage-x');
      doc.scenes = [
        slideScene('stage-x', 'third', 2),
        slideScene('stage-x', 'first', 0),
        slideScene('stage-x', 'second', 1),
      ];
      await store.saveDocument(doc);

      const loaded = await store.loadDocument('stage-x');
      expect(loaded!.scenes.map((s) => s.id)).toEqual(['first', 'second', 'third']);
    });

    test('stamps the current DSL version on load', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument());
      const loaded = await store.loadDocument('stage-1');
      expect(loaded!.dslVersion).toBe(DSL_VERSION);
    });

    test('listDocuments returns one summary per stage with a scene count', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument('stage-1'));
      await store.saveDocument(makeDocument('stage-2'));

      const list = await store.listDocuments();
      expect(list.map((d) => d.id).sort()).toEqual(['stage-1', 'stage-2']);
      const one = list.find((d) => d.id === 'stage-1')!;
      expect(one).toMatchObject({ name: 'Intro Course', createdAt: 1000, sceneCount: 2 });
    });

    test('deleteDocument removes the stage, its scenes, and its outline', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument());
      await store.deleteDocument('stage-1');

      expect(await store.loadDocument('stage-1')).toBeNull();
      expect(await store.getScene('stage-1', 'scene-a')).toBeNull();
      expect(await store.listDocuments()).toEqual([]);
    });

    test('deleteDocument is idempotent', async () => {
      const store = makeStore();
      await store.deleteDocument('never-existed');
      await store.saveDocument(makeDocument());
      await store.deleteDocument('stage-1');
      await expect(store.deleteDocument('stage-1')).resolves.toBeUndefined();
    });

    // --- validation gate ---

    test('rejects a document whose stage is missing required fields', async () => {
      const store = makeStore();
      const doc = makeDocument();
      // drop the required `name`
      delete (doc.stage as { name?: string }).name;
      await expect(store.saveDocument(doc)).rejects.toThrow();
    });

    test('rejects a document with an invalid scene', async () => {
      const store = makeStore();
      const doc = makeDocument();
      // a slide scene whose content type disagrees with the scene type
      (doc.scenes[0] as { content: unknown }).content = { type: 'quiz', questions: [] };
      await expect(store.saveDocument(doc)).rejects.toThrow();
    });

    test('a rejected save leaves the store untouched (atomic)', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument());

      const bad = makeDocument();
      bad.stage.name = 'Renamed';
      bad.scenes.push({ id: 'broken', stageId: 'stage-1' } as unknown as Scene); // invalid scene
      await expect(store.saveDocument(bad)).rejects.toThrow();

      // original persists; nothing from the bad save landed
      const loaded = await store.loadDocument('stage-1');
      expect(loaded!.stage.name).toBe('Intro Course');
      expect(loaded!.scenes.map((s) => s.id)).toEqual(['scene-a', 'scene-b']);
      expect(await store.getScene('stage-1', 'broken')).toBeNull();
    });

    test('rejects a scene whose stageId does not match the document', async () => {
      const store = makeStore();
      const doc = makeDocument('stage-1');
      // a scene mis-assigned to a different stage would otherwise be written to a
      // phantom partition no read path can see — fail loud instead of losing it.
      doc.scenes = [slideScene('stage-1', 'ok', 0), slideScene('other-stage', 'stray', 1)];
      await expect(store.saveDocument(doc)).rejects.toThrow();
      // nothing landed: the whole save is rejected before any write
      expect(await store.loadDocument('stage-1')).toBeNull();
      expect(await store.getScene('other-stage', 'stray')).toBeNull();
    });

    test('rejects a scene with a non-finite order', async () => {
      const store = makeStore();
      const doc = makeDocument();
      // NaN/Infinity are `typeof number` but break the read-time `order` sort.
      (doc.scenes[0] as { order: number }).order = NaN;
      await expect(store.saveDocument(doc)).rejects.toThrow();
      expect(await store.loadDocument('stage-1')).toBeNull();
    });

    test('rejects duplicate scene ids within a document', async () => {
      const store = makeStore();
      const doc = makeDocument('stage-1');
      doc.scenes = [slideScene('stage-1', 'dup', 0), slideScene('stage-1', 'dup', 1)];
      await expect(store.saveDocument(doc)).rejects.toThrow();
      // rejected before any write — nothing landed
      expect(await store.loadDocument('stage-1')).toBeNull();
    });

    test('rejects saving a document stamped at an unknown/unreachable DSL version', async () => {
      const store = makeStore();
      const doc = makeDocument();
      // A stale stamp with no path up the DSL migration ladder is corrupt input —
      // fail loud rather than persist it mislabeled as current.
      doc.dslVersion = '0.0.1';
      await expect(store.saveDocument(doc)).rejects.toThrow();
      expect(await store.loadDocument('stage-1')).toBeNull();
    });

    test('normalizes a legacy-stamped document to the current version on save', async () => {
      const store = makeStore();
      const doc = makeDocument();
      // A pre-versioning stamp is lifted forward by the ladder, then persisted at
      // the current version (never mislabeled without running migrate()).
      doc.dslVersion = '0.0.0';
      await store.saveDocument(doc);
      const loaded = await store.loadDocument('stage-1');
      expect(loaded!.dslVersion).toBe(DSL_VERSION);
      // the opaque outline survives migration verbatim (it is not DSL-shaped, so
      // migrations never see it)
      expect(loaded!.outline).toEqual(doc.outline);
    });

    test('rejects saving a document written by a newer client', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument()); // current

      const future = makeDocument();
      future.dslVersion = '99.0.0';
      future.stage.name = 'Should Not Persist';
      // an old client must not overwrite (and downgrade) a newer-versioned document
      await expect(store.saveDocument(future)).rejects.toThrow();

      const loaded = await store.loadDocument('stage-1');
      expect(loaded!.stage.name).toBe('Intro Course');
    });

    // --- incremental scene ops ---

    test('putScene inserts a new scene into an existing document', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument());
      await store.putScene('stage-1', slideScene('stage-1', 'scene-c', 2));

      const loaded = await store.loadDocument('stage-1');
      expect(loaded!.scenes.map((s) => s.id)).toEqual(['scene-a', 'scene-b', 'scene-c']);
    });

    test('putScene overwrites an existing scene', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument());
      await store.putScene('stage-1', slideScene('stage-1', 'scene-a', 0, 'Renamed Title'));

      const scene = await store.getScene('stage-1', 'scene-a');
      expect(scene!.title).toBe('Renamed Title');
    });

    test('putScene rejects a scene whose stageId does not match the argument', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument('stage-1'));
      await expect(
        store.putScene('stage-1', slideScene('other-stage', 'stray', 2)),
      ).rejects.toThrow();
      // the mismatched scene is not reachable under either stage
      expect(await store.getScene('stage-1', 'stray')).toBeNull();
      expect(await store.getScene('other-stage', 'stray')).toBeNull();
    });

    test('putScene rejects when the parent document is absent', async () => {
      const store = makeStore();
      await expect(
        store.putScene('ghost-stage', slideScene('ghost-stage', 's', 0)),
      ).rejects.toThrow();
    });

    test('putScene validates the scene', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument());
      await expect(
        store.putScene('stage-1', { id: 'x', stageId: 'stage-1' } as unknown as Scene),
      ).rejects.toThrow();
    });

    test('getScene returns null for a missing scene', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument());
      expect(await store.getScene('stage-1', 'no-such-scene')).toBeNull();
    });

    test('deleteScene removes one scene and leaves the others', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument());
      await store.deleteScene('stage-1', 'scene-a');

      const loaded = await store.loadDocument('stage-1');
      expect(loaded!.scenes.map((s) => s.id)).toEqual(['scene-b']);
      await expect(store.deleteScene('stage-1', 'scene-a')).resolves.toBeUndefined();
    });

    test('deleteScene on an absent document is a no-op', async () => {
      const store = makeStore();
      await expect(store.deleteScene('ghost-stage', 'x')).resolves.toBeUndefined();
    });

    // --- diff-on-write (observable behaviour) ---

    test('re-saving reconciles added / edited / removed scenes', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument()); // scene-a, scene-b

      const next = makeDocument();
      next.scenes = [
        slideScene('stage-1', 'scene-a', 0, 'Edited A'), // edited
        slideScene('stage-1', 'scene-c', 1), // added; scene-b removed
      ];
      await store.saveDocument(next);

      const loaded = await store.loadDocument('stage-1');
      expect(loaded!.scenes.map((s) => s.id)).toEqual(['scene-a', 'scene-c']);
      expect(loaded!.scenes.find((s) => s.id === 'scene-a')!.title).toBe('Edited A');
      expect(await store.getScene('stage-1', 'scene-b')).toBeNull();
    });

    // --- outline snapshot ---

    test('persists the outline verbatim and can clear it', async () => {
      const store = makeStore();
      const doc = makeDocument();
      await store.saveDocument(doc);
      expect((await store.loadDocument('stage-1'))!.outline).toEqual(doc.outline);

      const withoutOutline = makeDocument();
      delete withoutOutline.outline;
      await store.saveDocument(withoutOutline);
      expect((await store.loadDocument('stage-1'))!.outline).toBeUndefined();
    });

    test('documents are isolated from one another', async () => {
      const store = makeStore();
      await store.saveDocument(makeDocument('stage-1'));
      await store.saveDocument(makeDocument('stage-2'));
      await store.deleteScene('stage-1', 'scene-a');

      // stage-2 untouched by a stage-1 scene delete
      const two = await store.loadDocument('stage-2');
      expect(two!.scenes.map((s) => s.id)).toEqual(['scene-a', 'scene-b']);
    });
  });
}
