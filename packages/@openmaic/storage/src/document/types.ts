/**
 * DocumentStore — persist the DSL `document` aggregate (a course: stage metadata
 * + scenes + embedded agents / quiz / actions + an app-owned outline snapshot).
 *
 * The DSL owns the *entities* (`Stage`, `Scene`) and the *what* of persistence
 * (shape + validation + migration); this store owns the *where/how*: it
 * normalizes the embedded aggregate into per-entity rows on write (diffing so it
 * touches only changed children) and reassembles them on read, migrating the
 * whole document forward via the DSL migration ladder. The pluggable seam is the
 * backend, not the database driver — every backend satisfies one contract test.
 */
import type { Stage, Scene } from '@openmaic/dsl';

/**
 * The minimal scene shape the store itself depends on — the fields it uses to
 * normalize (`stageId` + `id` are the compound row key), order (`order`), and
 * integrity-check scenes. The DSL `Scene` satisfies it. The store is generic
 * over the concrete scene type so an app can persist its own widened scene union
 * (interactive / pbl / …) — content the DSL does not own — by supplying a
 * matching {@link SceneValidator}. Everything below `SceneLike` is opaque to the
 * store and rides along verbatim.
 */
export interface SceneLike {
  id: string;
  stageId: string;
  order: number;
}

/**
 * Validate a scene at the write boundary. Defaults to the DSL `validateScene`
 * (which owns the universal `slide` / `quiz` kinds); an app that widens `Scene`
 * with its own content kinds injects a validator that also accepts those, so the
 * gate stays fail-loud for the app's shapes rather than silently rejecting them.
 */
export type SceneValidator = (
  scene: unknown,
) => { valid: true } | { valid: false; errors: { path: string; message: string }[] };

/** Validate a stage at the write boundary. Defaults to the DSL `validateStage`. */
export type StageValidator = (
  stage: unknown,
) => { valid: true } | { valid: false; errors: { path: string; message: string }[] };

/** A document write was rejected because its persisted DSL version is incompatible. */
export class DocumentVersionError extends Error {
  override readonly name = 'DocumentVersionError';

  constructor(
    readonly stageId: string,
    readonly kind: 'future' | 'not-current',
    readonly storedVersion: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** An incremental document write requires a parent document that does not exist. */
export class DocumentNotFoundError extends Error {
  override readonly name = 'DocumentNotFoundError';

  constructor(
    readonly stageId: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The portable, embedded form of a persisted course. Storage normalizes it into
 * per-entity rows on write and reassembles it on read.
 *
 * `scenes` defaults to the DSL `Scene` (bare = `Scene<Action, SlideContent |
 * QuizContent>`, a discriminated union). Apps widen `TScene` with their own
 * scene union — the store treats scene content opaquely and only touches the
 * {@link SceneLike} fields.
 *
 * `outline` is an opaque, app-owned snapshot (the DSL owns no outline type). The
 * store persists it verbatim and never inspects it — it is not validated and not
 * migrated. Snapshot semantics: it captures original generation intent and is
 * not kept in sync as scenes are edited.
 *
 * `dslVersion` is the migrate() envelope stamp ({@link DSL_VERSION_KEY}); absent
 * on legacy data written before the version field existed.
 */
export interface MaicDocument<TScene extends SceneLike = Scene, TStage extends Stage = Stage> {
  stage: TStage;
  scenes: TScene[];
  outline?: unknown;
  dslVersion?: string;
}

/**
 * A lightweight per-document row for a course picker — enough to render a list
 * without loading whole documents.
 */
export interface DocumentSummary {
  id: string;
  name: string;
  /** Optional stage metadata whose meaning is independent of the DSL version. */
  description?: string;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
  createdAt: number;
  updatedAt: number;
  sceneCount: number;
}

/**
 * Persist DSL `document` aggregates. `saveDocument` validates and writes the
 * whole aggregate (diffing scene rows); `loadDocument` reassembles and
 * migrate-on-reads. The `*Scene` methods are incremental conveniences over the
 * normalized rows for scene-level editing.
 */
export interface DocumentStore<TScene extends SceneLike = Scene, TStage extends Stage = Stage> {
  /**
   * Validate the aggregate, stamp it at the current DSL version, split it into
   * rows, write every scene, and delete scenes no longer present. Atomic: an
   * invalid stage or scene throws before anything is written. (Reliably diffing
   * opaque scene content is not attempted; cheap per-scene writes use
   * {@link putScene}.)
   */
  saveDocument(doc: MaicDocument<TScene, TStage>): Promise<void>;

  /**
   * Reassemble the document for `stageId` (scenes sorted by `order`, outline
   * attached), migrated forward to the current DSL version. `null` if absent.
   */
  loadDocument(stageId: string): Promise<MaicDocument<TScene, TStage> | null>;

  /**
   * A summary per stored document. Returns only version-independent fields
   * (id / name / optional display metadata / timestamps / sceneCount) and never
   * migrates or reads content,
   * so — unlike the content APIs — it intentionally tolerates a corrupt or
   * unrecognized `dslVersion` stamp rather than failing the whole listing on one
   * bad row (a broken document still surfaces fail-loud when actually opened).
   */
  listDocuments(): Promise<DocumentSummary[]>;

  /**
   * Cascade-delete the stage, its scenes, and its outline. Idempotent. Unlike
   * the incremental scene mutations, a whole-document removal is a deliberate
   * coarse action and is intentionally not version-guarded.
   */
  deleteDocument(stageId: string): Promise<void>;

  /**
   * Validate and upsert the stage row of an existing, already-current document
   * without touching its scenes or outline. The stored document must be at the
   * current DSL version for the same reason as {@link putScene}: a stale row
   * must be normalized by a full load + save, and a newer row must not be
   * downgraded. Throws if the document is absent, not current, or `stage.id`
   * does not match `stageId`.
   */
  putStage(stageId: string, stage: TStage): Promise<void>;

  /**
   * Validate and upsert a single scene into an existing, already-current
   * document. The stored document must be at the current DSL version: a stale
   * document would leave its unmigrated sibling scenes stranded above the
   * migrate-on-read line, and a newer one must not be downgraded — so an
   * incremental write into a non-current document is rejected (normalize it with
   * a `loadDocument` + `saveDocument` first). Throws if the parent document is
   * absent or not current, or the scene does not belong to `stageId`.
   */
  putScene(stageId: string, scene: TScene): Promise<void>;

  /**
   * Read a single scene, migrated forward via its parent document's version.
   * `null` if the scene or its document is absent.
   */
  getScene(stageId: string, sceneId: string): Promise<TScene | null>;

  /**
   * Delete a single scene. Idempotent (a no-op if the document or scene is
   * absent). Like `putScene`, this incremental mutation requires the stored
   * document to be current, so it throws on a stale or newer-versioned document.
   */
  deleteScene(stageId: string, sceneId: string): Promise<void>;
}
