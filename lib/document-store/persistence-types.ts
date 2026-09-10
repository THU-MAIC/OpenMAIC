import type { MaicDocument } from '@openmaic/storage';
import type { Stage } from '@openmaic/dsl';

import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';

/** App-owned stage shape. Device playback position is not document metadata. */
export type AppStage = Stage;

/**
 * Who produces the scenes of this course.
 *
 * `'client'` (the default, and what an absent field means) is the historical
 * app: the browser drives `useSceneGenerator` against the user's own model
 * config, so an interrupted deck must be resumed by whichever tab opens it.
 * `'server-job'` is the agent runtime (`lib/server/agent-runtime/`): a
 * long-lived agent job owns the course and the browser is an observer that
 * must never produce a scene, however incomplete the deck looks.
 *
 * This is a separate axis from `generationComplete`, and separating them is the
 * point. "Is this course finished" and "may this browser generate the missing
 * pages" are different questions; conflating them forces a server-owned course
 * to claim it is complete from its very first write just to keep the browser
 * out.
 */
export type DocumentProducer = 'client' | 'server-job';

/** Generation intent stored opaquely with the document aggregate. */
export interface AppDocumentOutline {
  outlines: SceneOutline[];
  /**
   * The requirement text the plan was generated from (agent runtime only).
   * Doubles as the replan idempotency key: a `generate_outline` replan
   * carrying the same requirement is a retry, not a new plan.
   */
  requirement?: string;
  generationComplete?: boolean;
  /** Absent = `'client'`, i.e. every course written before the agent runtime. */
  producer?: DocumentProducer;
  /** Opaque handle of the producing job, when one owns the course. */
  producerRef?: string;
  /**
   * Receipts of completed `import_pptx` calls, keyed by the same
   * `import_pptx:<key>` string that rides `requirement`. A material whose
   * receipt names pages still present in the stage is already imported — a
   * retry reports those pages instead of appending a second copy. The first
   * write onto a legacy document migrates the legacy `requirement` receipt
   * here so a later retry of that material stays a report.
   */
  pptxImports?: Record<string, { sceneIds: string[]; importedAt: number }>;
  createdAt: number;
  updatedAt: number;
}

/** Canonical app document persisted through the document-store seam. */
export type AppDocument = MaicDocument<AppScene, AppStage>;
