/**
 * The aggregate ↔ normalized adapter: the one translation point between the
 * portable, embedded {@link MaicDocument} and the per-entity rows a backend
 * stores. Pure and dependency-free (beyond DSL constants) so every backend —
 * browser today, HTTP later — shares the same split/reassemble semantics.
 *
 * The document is stamped at the root: the version envelope lives on the stage
 * (root) row, so a document has exactly one version, never a per-scene skew.
 */
import { DSL_VERSION, DSL_VERSION_KEY } from '@openmaic/dsl';
import type { Stage } from '@openmaic/dsl';
import type { MaicDocument, SceneLike } from './types.js';

/** The stage (root) row: stage metadata plus the document's version stamp. */
export type StageRow = Stage & { [DSL_VERSION_KEY]: string };

/** The outline row: one opaque snapshot per stage, stored only when present. */
export interface OutlineRow {
  stageId: string;
  outline: unknown;
}

/** The normalized rows a document splits into. */
export interface DocumentRows<TScene extends SceneLike> {
  stageRow: StageRow;
  sceneRows: TScene[];
  /** Present only when the document carries an outline. */
  outlineRow?: OutlineRow;
}

/**
 * Split an embedded document into normalized rows, stamping the stage row at the
 * current DSL version (a fresh write is always current). The outline row is
 * emitted only when the document actually carries an outline — a document with
 * no outline produces no outline row (and the backend removes any stale one).
 */
export function splitDocument<TScene extends SceneLike>(
  doc: MaicDocument<TScene>,
): DocumentRows<TScene> {
  const stageRow: StageRow = { ...doc.stage, [DSL_VERSION_KEY]: DSL_VERSION };
  const rows: DocumentRows<TScene> = { stageRow, sceneRows: doc.scenes };
  if (doc.outline !== undefined) {
    rows.outlineRow = { stageId: doc.stage.id, outline: doc.outline };
  }
  return rows;
}

/**
 * Reassemble normalized rows into an embedded document — the inverse of
 * {@link splitDocument}. Scenes are returned sorted by `order`, the version is
 * lifted from the stage row to the document root (where the migrate() runner
 * reads it), and the outline is attached only when a row exists. This is the
 * pre-migration document; the backend runs `migrate()` on the result.
 */
export function reassembleDocument<TScene extends SceneLike>(
  stageRow: StageRow,
  sceneRows: TScene[],
  outlineRow?: OutlineRow,
): MaicDocument<TScene> {
  const { [DSL_VERSION_KEY]: dslVersion, ...stage } = stageRow;
  const scenes = [...sceneRows].sort((a, b) => a.order - b.order);
  const doc: MaicDocument<TScene> = { stage, scenes, dslVersion };
  if (outlineRow) doc.outline = outlineRow.outline;
  return doc;
}
