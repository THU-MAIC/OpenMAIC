// Unit tests for the pure aggregate <-> normalized adapter, independent of any
// backend. The backend contract exercises these too, but pinning them here locks
// the split/reassemble semantics a future HTTP backend must also honour.
import { describe, expect, test } from 'vitest';
import { DSL_VERSION, DSL_VERSION_KEY } from '@openmaic/dsl';
import { reassembleDocument, splitDocument } from '../src/document/adapter.js';
import { makeDocument, slideScene } from './document-contract.js';

describe('splitDocument', () => {
  test('stamps the current DSL version on the stage row', () => {
    const { stageRow } = splitDocument(makeDocument());
    expect(stageRow[DSL_VERSION_KEY]).toBe(DSL_VERSION);
  });

  test('emits an outline row only when the document carries an outline', () => {
    const withOutline = splitDocument(makeDocument());
    expect(withOutline.outlineRow).toEqual({
      stageId: 'stage-1',
      outline: { entries: [{ id: 'o1', title: 'Intro' }], generationComplete: true },
    });

    const bare = makeDocument();
    delete bare.outline;
    expect(splitDocument(bare).outlineRow).toBeUndefined();
  });
});

describe('reassembleDocument', () => {
  test('sorts scenes by order and lifts the version to the document root', () => {
    const rows = splitDocument({
      stage: { id: 'stage-1', name: 'C', createdAt: 1, updatedAt: 2 },
      scenes: [slideScene('stage-1', 'b', 1), slideScene('stage-1', 'a', 0)],
    });
    const doc = reassembleDocument(rows.stageRow, rows.sceneRows, rows.outlineRow);

    expect(doc.scenes.map((s) => s.id)).toEqual(['a', 'b']);
    expect(doc.dslVersion).toBe(DSL_VERSION);
    // the version stamp does not leak back onto the stage
    expect(DSL_VERSION_KEY in doc.stage).toBe(false);
    expect(doc.outline).toBeUndefined();
  });

  test('round-trips a document through split then reassemble', () => {
    const original = makeDocument();
    const rows = splitDocument(original);
    const doc = reassembleDocument(rows.stageRow, rows.sceneRows, rows.outlineRow);

    expect(doc.stage).toEqual(original.stage);
    expect(doc.scenes).toEqual(original.scenes);
    expect(doc.outline).toEqual(original.outline);
  });
});
