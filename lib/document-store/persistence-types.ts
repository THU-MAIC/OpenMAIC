import type { MaicDocument } from '@openmaic/storage';
import type { Stage } from '@openmaic/dsl';

import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';

/** App-owned stage shape. Device playback position is not document metadata. */
export type AppStage = Stage;

/** Generation intent stored opaquely with the document aggregate. */
export interface AppDocumentOutline {
  outlines: SceneOutline[];
  generationComplete?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Canonical app document persisted through the document-store seam. */
export type AppDocument = MaicDocument<AppScene, AppStage>;
