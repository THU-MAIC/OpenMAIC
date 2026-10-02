/**
 * The browser's view of a server-side generation run (RFC #1754 §E): the run's
 * wire shapes, as the run API answers them, and the view the run client folds
 * its snapshot and ordered event log into.
 */
import type {
  GenerationRunAgentsResult,
  GenerationRunEventType,
  GenerationRunFailure,
  GenerationRunInput,
  GenerationRunMediaState,
  GenerationRunOutline,
  GenerationRunProgress,
  GenerationRunState,
} from '@/lib/server/generation/run/types';
import type { SceneOutline } from '@/lib/types/generation';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

export type {
  GenerationRunInput,
  GenerationRunMediaState,
  GenerationRunState,
} from '@/lib/server/generation/run/types';

/** `GET /api/generation-runs/:id` (`media` is absent from the list and owner-stream snapshots). */
export interface RunSnapshot {
  id: string;
  state: GenerationRunState;
  step: string | null;
  seq: number;
  input: GenerationRunInput;
  outline: (GenerationRunOutline & { revision: number }) | null;
  agents: GenerationRunAgentsResult | null;
  stageId: string | null;
  progress: GenerationRunProgress;
  error: GenerationRunFailure | null;
  createdAt: string;
  updatedAt: string;
  media?: Record<string, GenerationRunMediaState>;
  /** What the material analysis reported (in the run's own snapshot). */
  materialKinds?: Array<'document' | 'media'>;
  materialTruncated?: { textChars?: number; images?: { total: number; max: number } };
}

/** One frame of `GET /api/generation-runs/:id/events`. */
export interface RunEvent {
  seq: number;
  type: GenerationRunEventType;
  data: Record<string, unknown>;
}

/** A failed scene step the run went on past (parallel content), by scene index. */
export type SkippedScenes = Record<number, string>;

export interface RunView {
  runId: string;
  /** The last event folded in. */
  seq: number;
  state: GenerationRunState;
  step: string | null;
  /** The seq of the last `step_started`: a step queued by Retry has not started until it moves. */
  stepStartedSeq: number;
  input: GenerationRunInput;
  /** The outline items streamed so far (until the outline is ready). */
  streamingOutlines: SceneOutline[];
  /** True between an outline stream's restart and its next item. */
  outlineRetrying: boolean;
  /** The outline the run waits on or generates, with its revision. */
  outline: (GenerationRunOutline & { revision: number }) | null;
  researchSources: Array<{ title: string; url: string }>;
  /** Whether each material (in order) is a document or audio/video, once the analysis says. */
  materialKinds: Array<'document' | 'media'> | null;
  /** The materials are analyzed (the preview drops the analysis step then, as it always did). */
  materialsAnalyzed: boolean;
  /** What of the materials the outline does not see in full. */
  materialTruncated: { textChars?: number; images?: { total: number; max: number } } | null;
  /** The generated roster (auto agents), for the agent cards. */
  generatedAgents: GeneratedAgentConfig[] | null;
  stageId: string | null;
  progress: GenerationRunProgress;
  /** Scene ids the course holds, by scene index, as `scene_ready` reported them. */
  readyScenes: Record<number, string>;
  skippedScenes: SkippedScenes;
  error: GenerationRunFailure | null;
  /** The seq of the failure the run is paused at (the key of its Retry command). */
  failedSeq: number;
  media: Record<string, RunMediaView>;
}

/** A media element's state, with the seq of the event that set it (the key of its Retry command). */
export type RunMediaView = GenerationRunMediaState & { seq: number };

/** A run that will not change any more. */
export function isFinishedRunState(state: GenerationRunState): boolean {
  return state === 'completed' || state === 'ended';
}
