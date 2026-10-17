/**
 * Server-side generation runs (RFC #1754 §E): the shapes a run is stored,
 * reported and commanded in.
 *
 * A run is an owner-scoped PostgreSQL record that executes the classic
 * pipeline with the shared step functions (`lib/server/generation/steps/`),
 * checkpointing after every step. The browser, the headless API and scripts
 * start a run, follow its ordered event log and send it commands; none of them
 * drives the steps.
 */
import type { AgentInfo } from '@openmaic/generation';

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { SceneOutline } from '@/lib/types/generation';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

/**
 * `preparing` (material analysis, research) → `outlining` →
 * `awaiting_outline_confirmation` → `generating` → `completed`. A step that
 * fails after its retries leaves the run `paused` at that step; deleting the
 * course ends it (`ended`) at the next step boundary.
 */
export const GENERATION_RUN_STATES = [
  'preparing',
  'outlining',
  'awaiting_outline_confirmation',
  'generating',
  'paused',
  'completed',
  'ended',
] as const;
export type GenerationRunState = (typeof GENERATION_RUN_STATES)[number];

/** States a runner executes; the others hold no worker. */
export const EXECUTABLE_RUN_STATES = ['preparing', 'outlining', 'generating'] as const;
export type ExecutableRunState = (typeof EXECUTABLE_RUN_STATES)[number];

/** States of a run that is not over: what course cards show. */
export const ACTIVE_RUN_STATES = [
  'preparing',
  'outlining',
  'awaiting_outline_confirmation',
  'generating',
  'paused',
] as const;

/**
 * States that count against the per-owner limit on active runs. A run waiting
 * for its outline to be confirmed and a paused run hold no worker, so they do
 * not count; confirming the outline and a step Retry make the run count again,
 * and are refused over the limit.
 */
export const LIMITED_RUN_STATES = ['preparing', 'outlining', 'generating'] as const;

/**
 * How long a `countdown` run's outline waits for a `hold-outline` before the
 * run confirms it itself (the pause 1.1.x's preview gave the learner).
 */
export const OUTLINE_AUTO_CONFIRM_MS = 2500;

/** Which agents teach the course. */
export type GenerationRunAgents =
  /**
   * Generate course-specific agents (the agent-profiles step). When that
   * fails, the course is taught by `presetAgentIds`, the learner's selected
   * preset agents (as the browser falls back to its selection).
   */
  | { mode: 'auto'; presetAgentIds?: string[] }
  /**
   * These agents, by id: built-in ones or the owner's custom ones; none is the
   * default presets (what the learner's selection starts out as).
   */
  | { mode: 'preset'; agentIds: string[] };

/**
 * What a run generates from. No keys and no models: every model and provider
 * resolves through the owner's capability slots.
 */
export interface GenerationRunInput {
  requirement: string;
  /** Owner-library uploads (`POST /api/materials`), in order. */
  materialIds: string[];
  interactive: boolean;
  taskEngine: boolean;
  agents: GenerationRunAgents;
  learnerProfile?: { nickname?: string; bio?: string };
  /**
   * How the outline is confirmed:
   * - `wait` holds the run for a `confirm-outline` command;
   * - `countdown` holds it for {@link OUTLINE_AUTO_CONFIRM_MS}, then the run
   *   confirms the outline itself unless a `hold-outline` command turned the
   *   run into a `wait` one first (any time before the outline is confirmed);
   * - `auto` confirms the outline in its own commit.
   */
  outlineReview: 'wait' | 'countdown' | 'auto';
  /**
   * The learner's narrator voice for the tts slot's provider (a voice is a
   * preference, not a model); the provider's default voice otherwise.
   */
  voice?: { providerId: string; voiceId: string; speed?: number };
  /**
   * The materials were uploaded for this run only (the composer's): they are
   * released when the run completes or ends. Callers that reuse material ids
   * across runs leave it out.
   */
  releaseMaterials?: boolean;
}

/** The outline a run generated, as last confirmed or edited. */
export interface GenerationRunOutline {
  outlines: SceneOutline[];
  languageDirective: string;
  courseTitle?: string;
  /** The server-effective task-engine mode the outline was generated in. */
  taskEngineMode: boolean;
}

/** A custom preset agent as narration reads it. */
export type GenerationRunCustomAgent = Pick<
  AgentConfig,
  | 'id'
  | 'name'
  | 'role'
  | 'persona'
  | 'avatar'
  | 'color'
  | 'priority'
  | 'voiceConfig'
  | 'voiceDesign'
>;

/** The agents a run teaches with, as the agents step resolved them. */
export interface GenerationRunAgentsResult {
  /** What the content and actions steps receive. */
  agents: AgentInfo[];
  /** The stage's `agentIds`. */
  agentIds: string[];
  /** The generated roster, embedded in the stage; absent for preset agents. */
  generatedAgentConfigs?: GeneratedAgentConfig[];
  /**
   * The owner's custom agents among the presets, with what their voice needs
   * (a custom teacher narrates with its own voice, as in the browser).
   */
  customAgents?: GenerationRunCustomAgent[];
}

/** The failure a paused run stopped at. */
export interface GenerationRunFailure {
  /** The step that failed; null when the run stopped before it chose one. */
  step: string | null;
  message: string;
  /**
   * The error code the classic route answered the same failure with
   * (`RATE_LIMITED`, `UPSTREAM_ERROR`, `GENERATION_FAILED`, `MISSING_API_KEY`,
   * `INTERNAL_ERROR`, ...), so a client can say it the way it always did.
   */
  errorCode?: string;
  /** The provider's HTTP status, for a provider's refusal. */
  statusCode?: number;
  /** In a run's own snapshot: the seq of the `step_failed` event that reported it. */
  failureSeq?: number;
  /** Where `retry` resumes a run that stopped without a step. */
  resumeState?: ExecutableRunState;
}

export interface GenerationRunProgress {
  /** Scenes the outline plans (0 before it is confirmed). */
  scenesTotal: number;
  /** Scenes already in the course document. */
  scenesCompleted: number;
}

/** A submitted provider task: the id means something to that provider, model and endpoint only. */
export interface GenerationRunVideoTask {
  taskId: string;
  providerId: string;
  model: string;
  endpoint: string;
}

/**
 * One generated image or video of a run, as its checkpoint (`media:<elementId>`)
 * records it.
 *
 * - `queued`: to be generated; `generating`: a worker is generating it (a
 *   takeover generates it again);
 * - `submitted`: a video task the provider is working on, whose wait a
 *   takeover resumes instead of submitting again;
 * - `stored`: the bytes are in the asset pool and wait for the scene that
 *   holds the placeholder;
 * - `done`: the course names the asset (or, when no scene held the
 *   placeholder when the run completed, the run finished without one);
 * - `skipped`: its slot was turned off or unassigned when the pass reached it
 *   (the placeholder renders as disabled); a Retry generates it once the slot
 *   resolves, as the browser's next pass would;
 * - `failed`: the placeholder stays, with a Retry unless the failure is final
 *   (a video's Retry submits a new task, as the browser's does).
 */
export type GenerationRunMediaCheckpoint = { mediaType: 'image' | 'video' } & (
  | { status: 'queued' }
  | { status: 'generating' }
  | { status: 'submitted'; task: GenerationRunVideoTask }
  | {
      status: 'stored';
      assetId: string;
      posterAssetId?: string;
      /** Placements of these bytes that failed in a row (see `MAX_PLACEMENT_ATTEMPTS`). */
      placementFailures?: number;
    }
  | { status: 'done'; assetId: string; posterAssetId?: string }
  | { status: 'skipped' }
  | { status: 'failed'; message: string; errorCode?: string }
);

/**
 * The states a client renders for a media element, as the browser's media
 * tasks have them: `pending`, `generating`, `done` (with the asset, once the
 * course names it), `disabled` (its slot is off), `failed` (with the reason,
 * and an error code when the failure has one).
 */
export interface GenerationRunMediaEventData {
  elementId: string;
  mediaType: 'image' | 'video';
  status: 'pending' | 'generating' | 'done' | 'disabled' | 'failed';
  assetId?: string;
  posterAssetId?: string;
  message?: string;
  errorCode?: string;
  /** Whether Retry may be offered for a failure. */
  retryable?: boolean;
  /** In a snapshot, for a failed or skipped item: the seq of the event that reported it. */
  failureSeq?: number;
}

/** A media element's state in a run snapshot. */
export type GenerationRunMediaState = Omit<GenerationRunMediaEventData, 'elementId'>;

/** A run as its owner reads it. */
export interface GenerationRunSnapshot {
  id: string;
  state: GenerationRunState;
  /** The step running now, the step a paused run stopped at, or null between phases. */
  step: string | null;
  /** The last event's sequence number: follow with `GET …/events?after=<seq>`. */
  seq: number;
  input: GenerationRunInput;
  outline: (GenerationRunOutline & { revision: number }) | null;
  agents: GenerationRunAgentsResult | null;
  /** The course, once its document exists. */
  stageId: string | null;
  progress: GenerationRunProgress;
  error: GenerationRunFailure | null;
  /** Cumulative speech clips left unvoiced during generation, not current missing audio. */
  narrationUnvoiced?: number;
  /** A `countdown` run waiting for its outline: when the run confirms it itself (ISO). */
  outlineAutoConfirmAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One durable entry of a run's ordered event log. */
export interface GenerationRunEvent {
  runId: string;
  seq: number;
  ts: number;
  type: GenerationRunEventType;
  data: Record<string, unknown>;
}

export const GENERATION_RUN_EVENT_TYPES = [
  /** `{ state, step }`: the run changed state. */
  'state',
  /** `{ step }`: a step started. */
  'step_started',
  /** `{ step, attempt, maxAttempts, reason }`: a step is being retried. */
  'step_retry',
  /** `{ step }`: a step committed its output. */
  'step_completed',
  /** `{ step, message }`: a step failed after its retries; the run pauses. */
  'step_failed',
  /** `{ kinds }`: whether each material (in order) is a `document` or audio/video `media`. */
  'material_kinds',
  /**
   * `{ textChars?, images?: { total, max } }`: the material text or images the
   * outline does not see in full (text cut at `textChars` characters, the
   * first `max` of `total` images).
   */
  'material_truncated',
  /** `{ sources }`: what the research step found. */
  'research_sources',
  /** The outline stream restarted (a retry, a takeover): discard the items so far. */
  'outline_reset',
  /** `{ data }`: the language directive the outline stream inferred. */
  'outline_language_directive',
  /** `{ data }`: the course title the outline stream inferred. */
  'outline_course_title',
  /** `{ index, outline }`: one outline item as the model wrote it. */
  'outline_item',
  /** `{ revision, outline }`: the outline waits for confirmation. */
  'outline_ready',
  /** `{ revision, edited, automatic? }`: the outline was confirmed (`automatic`: by the run itself). */
  'outline_confirmed',
  /**
   * `{ outlineReview, autoConfirmAt }`: how the outline is confirmed changed:
   * a `countdown` run's outline is confirmed by the run at `autoConfirmAt`
   * (ISO) unless held; a held run waits for `confirm-outline` (`wait`, null).
   */
  'outline_review',
  /** `{ agents }`: the agents the course teaches with. */
  'agents',
  /** `{ stageId }`: the course document exists (its first scene is ready). */
  'course_created',
  /** `{ index, sceneId, order, narrationUnvoiced }`: a scene was appended; cumulative skipped clips. */
  'scene_ready',
  /** `{ stageId }`: every scene is in the course. */
  'completed',
  /** `{ stageId }`: the course was deleted; the run ended. */
  'ended',
  /**
   * `{ elementId, mediaType, status, ... }`: a generated image or video
   * changed state (see {@link GenerationRunMediaEventData}).
   */
  'media',
] as const;
export type GenerationRunEventType = (typeof GENERATION_RUN_EVENT_TYPES)[number];

export type NewGenerationRunEvent = Pick<GenerationRunEvent, 'type' | 'data'>;
