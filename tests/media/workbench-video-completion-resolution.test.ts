/**
 * A workbench video that completed through the asset pool must actually render.
 *
 * The storage half of #1522 can be entirely correct — bytes in the pool, a
 * `document_asset_refs` row, a committed entry, quota accounted — and the
 * video still be invisible, because what renders it is a different chain
 * altogether: `getVideoMediaRefForElement` reads `mediaRef` before `src`,
 * `resolveVideoMediaForElement` derives `sourceRef` from that, and
 * `poolLeasableSlideRefs` leases only `sourceRef`. A completion patch that
 * wrote the allocated id into `src` and left `mediaRef` on `gen_vid_…` would
 * leave the pool never asked about the id at all, and no storage test would
 * notice.
 *
 * So this file runs the REAL completion patch and feeds its output to the REAL
 * resolvers, in the two states a viewer can be in: the live pane, and a reload
 * where the document holds the ids and no task exists in memory.
 */
import { describe, expect, it } from 'vitest';
import type { PPTVideoElement, Slide } from '@openmaic/dsl';

import { patchStageVideoPlaceholder } from '@/lib/server/agent-runtime/generate-video';
import { collectUnresolvedMediaPlaceholders } from '@/lib/server/agent-runtime/generation-tools';
import { poolLeasableSlideRefs } from '@/components/slide-renderer/use-resolved-slide';
import { getVideoMediaRefForElement } from '@/lib/media/video-manifest';
import { resolveVideoMediaForElement } from '@/lib/media/media-task-resolution';
import {
  MISSING_ASSET_LEASE,
  renderableMediaUrl,
  resolveMediaRef,
} from '@/lib/media/resolve-media-ref';
import type { AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import type { AppScene, Scene } from '@/lib/types/stage';

import { createFakeDocumentStore } from '../agent-runtime/_fake-document-store';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const STAGE = 'stage-owner';
const REF = 'gen_vid_1';
const VIDEO_ID = 'ast_video_1';
const POSTER_ID = 'ast_poster_1';
const pooled = { status: 'resolved', url: 'blob:pool-video' } satisfies AssetUrlLeaseState;

/** Run the real completion patch over one element and return what it persisted. */
async function completeJobOn(element: Record<string, unknown>): Promise<PPTVideoElement> {
  const fake = createFakeDocumentStore();
  const scene = makeSlideScene('scene-1', STAGE, 1) as AppScene;
  (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push(element);
  fake.docs.set(STAGE, makeDocument(STAGE, 'Course', [scene]));

  const patched = await patchStageVideoPlaceholder(fake.store, STAGE, REF, {
    src: VIDEO_ID,
    poster: POSTER_ID,
  });
  expect(patched).toBe(1);

  const persisted = await fake.store.getScene(STAGE, 'scene-1');
  return (persisted!.content as { canvas: { elements: PPTVideoElement[] } }).canvas.elements[0]!;
}

function slideOf(element: PPTVideoElement): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [element],
  } as unknown as Slide;
}

describe('a completed workbench video resolves through the real chain', () => {
  // This is the shape the tool itself instructs the model to write:
  // "patch_stage set mediaRef (or src) of an existing element".
  it('leases the allocated id for the documented mediaRef binding', async () => {
    const element = await completeJobOn({ id: 'el-video', type: 'video', mediaRef: REF });

    // Every step of the chain, in the order the renderer walks it.
    expect(getVideoMediaRefForElement(element)).toBe(VIDEO_ID);
    const binding = resolveVideoMediaForElement({}, element, STAGE);
    expect(binding.sourceRef).toBe(VIDEO_ID);
    expect(binding.posterRef).toBe(POSTER_ID);
    // The pool is asked about the video and its poster -- the fact that makes
    // the bytes reachable at all.
    expect(poolLeasableSlideRefs(slideOf(element), STAGE, {})).toEqual([VIDEO_ID, POSTER_ID]);
  });

  it('leases the allocated id when the placeholder lived in src', async () => {
    const element = await completeJobOn({ id: 'el-video', type: 'video', src: REF });

    expect(resolveVideoMediaForElement({}, element, STAGE).sourceRef).toBe(VIDEO_ID);
    expect(poolLeasableSlideRefs(slideOf(element), STAGE, {})).toEqual([VIDEO_ID, POSTER_ID]);
  });

  // The reload path: the document holds the ids and nothing is in memory.
  it('renders after a reload, with no task in the media store', async () => {
    const element = await completeJobOn({ id: 'el-video', type: 'video', mediaRef: REF });
    const binding = resolveVideoMediaForElement({}, element, STAGE);
    expect(binding.task).toBeUndefined();

    const resolution = resolveMediaRef(binding.sourceRef, undefined, pooled);
    expect(resolution).toEqual({ kind: 'url', url: 'blob:pool-video' });
    expect(renderableMediaUrl(resolution)).toBe('blob:pool-video');
  });

  it('stops reporting the patched element as an unrendered placeholder', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', STAGE, 1) as AppScene;
    (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
      id: 'el-video',
      type: 'video',
      mediaRef: REF,
    });
    fake.docs.set(STAGE, makeDocument(STAGE, 'Course', [scene]));
    expect(
      collectUnresolvedMediaPlaceholders((await fake.store.getScene(STAGE, 'scene-1')) as Scene),
    ).toHaveLength(1);

    await patchStageVideoPlaceholder(fake.store, STAGE, REF, { src: VIDEO_ID, poster: POSTER_ID });

    expect(
      collectUnresolvedMediaPlaceholders((await fake.store.getScene(STAGE, 'scene-1')) as Scene),
    ).toEqual([]);
  });

  // The bug this file exists for, pinned so it cannot come back quietly: a
  // patch that writes only `src` leaves the pool unasked and the element
  // unrenderable, in both states.
  it('would lease nothing if the completion patch left mediaRef on the placeholder', () => {
    const stale = {
      id: 'el-video',
      type: 'video',
      mediaRef: REF,
      src: VIDEO_ID,
    } as unknown as PPTVideoElement;

    expect(resolveVideoMediaForElement({}, stale, STAGE).sourceRef).toBe(REF);
    expect(poolLeasableSlideRefs(slideOf(stale), STAGE, {})).toEqual([]);
    expect(
      renderableMediaUrl(resolveMediaRef(REF, undefined, MISSING_ASSET_LEASE)),
    ).toBeUndefined();
  });
});

/**
 * The completion patch's whole state space, asserted against the invariant
 * rather than case by case.
 *
 * This block is the second round of findings on this one function: round 2
 * fixed the `mediaRef`-binding shape and left its mirror broken (a new job
 * delivered through `src` while `mediaRef` still named the previous allocated
 * id kept rendering the old video). Rather than add a third special case, the
 * rule is written down in `patchStageVideoPlaceholder`'s doc comment and every
 * combination is enumerated here:
 *
 *   src ∈ {this placeholder, previous ast_, user URL, legacy stage URL, absent}
 *   × mediaRef ∈ {this placeholder, previous ast_, other placeholder,
 *                 concrete URL (what the importer round-trips), absent}
 *   × poster ∈ {this placeholder, previous ast_, user URL, absent}
 *
 * Expectations are written out from the stated rules, not derived from what the
 * implementation does, so an implementation that drifts fails rather than
 * redefines the table. Where a row follows from one of the two pre-existing
 * replaceability policies rather than from the rules alone, the row says which.
 */
describe('the completion patch over its whole state space', () => {
  const P = 'gen_vid_job';
  const A = 'ast_previous';
  const U = 'https://cdn.example.com/user.mp4';
  const L = `/api/classroom-media/${STAGE}/media/old.mp4`;
  const O = 'gen_vid_other';
  /** A concrete URL in `mediaRef` — what the classroom importer round-trips. */
  const MU = 'https://cdn.example.com/imported.mp4';
  const N = 'ast_new_video';
  const NP = 'ast_new_poster';
  const UP = 'https://cdn.example.com/user.jpg';

  type Slot = string | undefined;

  interface Row {
    readonly src: Slot;
    readonly mediaRef: Slot;
    /** What the element must hold afterwards, and what the renderer must pick. */
    readonly expectedSrc: Slot;
    readonly expectedMediaRef: Slot;
    readonly expectedSourceRef: Slot;
  }

  // Matched rows come first; the rest are elements bound to no job of ours and
  // must come back byte-identical.
  const rows: readonly Row[] = [
    // Rule 1: every slot holding the placeholder takes the new id.
    { src: P, mediaRef: P, expectedSrc: N, expectedMediaRef: N, expectedSourceRef: N },
    {
      src: P,
      mediaRef: undefined,
      expectedSrc: N,
      expectedMediaRef: undefined,
      expectedSourceRef: N,
    },
    // `src` is absent here, and it is FILLED with the new id. That does not
    // follow from rule 1 alone -- no slot held the placeholder -- but from the
    // pre-existing `isReplaceableSrc` policy, which treats absent, empty and a
    // legacy this-stage URL as replaceable. Same policy, same reason, for `L`.
    { src: undefined, mediaRef: P, expectedSrc: N, expectedMediaRef: N, expectedSourceRef: N },
    { src: L, mediaRef: P, expectedSrc: N, expectedMediaRef: N, expectedSourceRef: N },
    // Rule 2: `src` took the new id, so anything else in `mediaRef` is retired
    // instead of shadowing it. `A`/`O` are the round-3 finding; `MU` is the
    // round-4 one -- the classroom importer round-trips a concrete `mediaRef`
    // and `patch_stage` accepts any string there, so a URL parked in that slot
    // used to hide the finished job.
    { src: P, mediaRef: A, expectedSrc: N, expectedMediaRef: undefined, expectedSourceRef: N },
    { src: P, mediaRef: O, expectedSrc: N, expectedMediaRef: undefined, expectedSourceRef: N },
    { src: P, mediaRef: MU, expectedSrc: N, expectedMediaRef: undefined, expectedSourceRef: N },
    // Rule 1 only: an allocated id in `src` is a choice and stays; `mediaRef`
    // carries the new id, which `sourceRef` prefers over a non-concrete `src`.
    { src: A, mediaRef: P, expectedSrc: A, expectedMediaRef: N, expectedSourceRef: N },
    // Rule 3: the user's own address wins, and no finished job is left named.
    // Rule 2 does not fire here -- `src` never took the new id.
    { src: U, mediaRef: P, expectedSrc: U, expectedMediaRef: N, expectedSourceRef: U },
    // Unmatched: neither slot names this job, so nothing is touched.
    { src: A, mediaRef: A, expectedSrc: A, expectedMediaRef: A, expectedSourceRef: A },
    { src: A, mediaRef: O, expectedSrc: A, expectedMediaRef: O, expectedSourceRef: O },
    { src: A, mediaRef: MU, expectedSrc: A, expectedMediaRef: MU, expectedSourceRef: MU },
    {
      src: A,
      mediaRef: undefined,
      expectedSrc: A,
      expectedMediaRef: undefined,
      expectedSourceRef: A,
    },
    { src: U, mediaRef: A, expectedSrc: U, expectedMediaRef: A, expectedSourceRef: U },
    { src: U, mediaRef: O, expectedSrc: U, expectedMediaRef: O, expectedSourceRef: U },
    { src: U, mediaRef: MU, expectedSrc: U, expectedMediaRef: MU, expectedSourceRef: U },
    {
      src: U,
      mediaRef: undefined,
      expectedSrc: U,
      expectedMediaRef: undefined,
      expectedSourceRef: U,
    },
    { src: L, mediaRef: A, expectedSrc: L, expectedMediaRef: A, expectedSourceRef: L },
    { src: L, mediaRef: O, expectedSrc: L, expectedMediaRef: O, expectedSourceRef: L },
    { src: L, mediaRef: MU, expectedSrc: L, expectedMediaRef: MU, expectedSourceRef: L },
    {
      src: L,
      mediaRef: undefined,
      expectedSrc: L,
      expectedMediaRef: undefined,
      expectedSourceRef: L,
    },
    {
      src: undefined,
      mediaRef: A,
      expectedSrc: undefined,
      expectedMediaRef: A,
      expectedSourceRef: A,
    },
    {
      src: undefined,
      mediaRef: O,
      expectedSrc: undefined,
      expectedMediaRef: O,
      expectedSourceRef: O,
    },
    {
      src: undefined,
      mediaRef: MU,
      expectedSrc: undefined,
      expectedMediaRef: MU,
      expectedSourceRef: MU,
    },
    {
      src: undefined,
      mediaRef: undefined,
      expectedSrc: undefined,
      expectedMediaRef: undefined,
      expectedSourceRef: undefined,
    },
  ];

  // The poster column follows `isReplaceablePoster`, the second pre-existing
  // policy: a replaceable poster takes the POSTER id, not the video id, and an
  // absent slot is filled. Neither follows from the three rules on their own.
  const posters: readonly { readonly poster: Slot; readonly expectedWhenMatched: Slot }[] = [
    // The job's own placeholder and an empty slot take the generated poster.
    { poster: P, expectedWhenMatched: NP },
    { poster: undefined, expectedWhenMatched: NP },
    // An allocated poster and an author's poster are choices; never overwritten.
    { poster: A, expectedWhenMatched: A },
    { poster: UP, expectedWhenMatched: UP },
  ];

  const matched = (row: Row): boolean => row.src === P || row.mediaRef === P;

  it('enumerates the whole space, with no row missing and none written twice', () => {
    // `rows.length * posters.length` would be true of any table, including one
    // a row was quietly dropped from. The cross product is named outright.
    const srcValues: readonly Slot[] = [P, A, U, L, undefined];
    const mediaRefValues: readonly Slot[] = [P, A, O, MU, undefined];
    const seen = rows.map((row) => `${row.src ?? '-'}|${row.mediaRef ?? '-'}`);
    const expected = srcValues.flatMap((src) =>
      mediaRefValues.map((mediaRef) => `${src ?? '-'}|${mediaRef ?? '-'}`),
    );
    expect([...seen].sort()).toEqual([...expected].sort());
    expect(rows).toHaveLength(25);
    expect(posters).toHaveLength(4);
    expect(rows.filter(matched)).toHaveLength(9);
  });

  const key = (row: Row, poster: Slot) =>
    `src=${row.src ?? '-'} mediaRef=${row.mediaRef ?? '-'} poster=${poster ?? '-'}`;

  it('resolves every combination to the invariant, in one write', async () => {
    const fake = createFakeDocumentStore();
    const scene = makeSlideScene('scene-1', STAGE, 1) as AppScene;
    const canvas = (scene.content as { canvas: { elements: unknown[] } }).canvas;
    for (const row of rows) {
      for (const { poster } of posters) {
        canvas.elements.push({
          id: key(row, poster),
          type: 'video',
          ...(row.src !== undefined ? { src: row.src } : {}),
          ...(row.mediaRef !== undefined ? { mediaRef: row.mediaRef } : {}),
          ...(poster !== undefined ? { poster } : {}),
        });
      }
    }
    expect(canvas.elements).toHaveLength(100);
    fake.docs.set(STAGE, makeDocument(STAGE, 'Course', [scene]));

    await patchStageVideoPlaceholder(fake.store, STAGE, P, { src: N, poster: NP });

    const persisted = await fake.store.getScene(STAGE, 'scene-1');
    const elements = (persisted!.content as { canvas: { elements: PPTVideoElement[] } }).canvas
      .elements;
    const byId = new Map(elements.map((element) => [element.id, element]));

    for (const row of rows) {
      for (const { poster, expectedWhenMatched } of posters) {
        const id = key(row, poster);
        const element = byId.get(id)!;
        const expectedPoster = matched(row) ? expectedWhenMatched : poster;
        expect({
          id,
          src: element.src,
          mediaRef: element.mediaRef,
          poster: element.poster,
        }).toEqual({
          id,
          src: row.expectedSrc,
          mediaRef: row.expectedMediaRef,
          poster: expectedPoster,
        });

        // What the renderer will actually ask the pool for.
        const binding = resolveVideoMediaForElement({}, element, STAGE);
        expect({ id, sourceRef: binding.sourceRef }).toEqual({
          id,
          sourceRef: row.expectedSourceRef,
        });

        if (!matched(row)) continue;
        // A completed job leaves nothing on its element waiting on a
        // generation: no `gen_*` placeholder in any slot, and never one as the
        // reference the renderer selects. (Allocated ids may remain — those are
        // choices, not pending work.)
        for (const value of [element.src, element.mediaRef, element.poster]) {
          expect({ id, value }).not.toMatchObject({ value: expect.stringMatching(/^gen_/) });
        }
        expect({ id, sourceRef: binding.sourceRef }).not.toMatchObject({
          sourceRef: expect.stringMatching(/^gen_/),
        });
      }
    }
  });

  it('asks the pool for the new id in every matched combination that is not a user pick', async () => {
    for (const row of rows.filter(matched)) {
      const fake = createFakeDocumentStore();
      const scene = makeSlideScene('scene-1', STAGE, 1) as AppScene;
      (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
        id: 'el',
        type: 'video',
        ...(row.src !== undefined ? { src: row.src } : {}),
        ...(row.mediaRef !== undefined ? { mediaRef: row.mediaRef } : {}),
      });
      fake.docs.set(STAGE, makeDocument(STAGE, 'Course', [scene]));

      await patchStageVideoPlaceholder(fake.store, STAGE, P, { src: N, poster: NP });

      const persisted = await fake.store.getScene(STAGE, 'scene-1');
      const element = (persisted!.content as { canvas: { elements: PPTVideoElement[] } }).canvas
        .elements[0]!;
      const leased = poolLeasableSlideRefs(slideOf(element), STAGE, {});
      const label = key(row, undefined);
      if (row.expectedSourceRef === U) {
        // Their address resolves itself; only the generated poster is leased.
        expect({ label, leased }).toEqual({ label, leased: [NP] });
      } else {
        expect({ label, leased }).toEqual({ label, leased: [N, NP] });
      }
    }
  });
});
