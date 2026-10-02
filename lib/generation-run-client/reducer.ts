/**
 * Fold a run's snapshot and its ordered event log into the view the browser
 * renders. Pure: the hooks feed it frames; tests drive it directly.
 *
 * Events carry a `seq`; one at or below the view's is a replay already
 * folded in and is ignored, so a reconnect that resends a frame changes
 * nothing. A `resync` (the log was compacted behind the cursor) is answered by
 * the caller with a fresh snapshot: `viewFromSnapshot` replaces the view.
 */
import type { SceneOutline } from '@/lib/types/generation';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

import type {
  GenerationRunMediaState,
  GenerationRunState,
  RunEvent,
  RunSnapshot,
  RunView,
} from './types';

/** The view a snapshot describes. */
export function viewFromSnapshot(snapshot: RunSnapshot): RunView {
  const generated = snapshot.agents?.generatedAgentConfigs;
  return {
    runId: snapshot.id,
    seq: snapshot.seq,
    state: snapshot.state,
    step: snapshot.step,
    stepStartedSeq: 0,
    input: snapshot.input,
    streamingOutlines: snapshot.outline?.outlines ?? [],
    outlineRetrying: false,
    outline: snapshot.outline,
    researchSources: [],
    materialKinds: snapshot.materialKinds ?? null,
    materialsAnalyzed:
      snapshot.state !== 'preparing' ||
      (snapshot.step !== null && snapshot.step !== 'material-analysis'),
    materialTruncated: snapshot.materialTruncated ?? null,
    generatedAgents: generated && generated.length > 0 ? generated : null,
    stageId: snapshot.stageId,
    progress: snapshot.progress,
    readyScenes: {},
    skippedScenes: {},
    error: snapshot.error,
    // A failure's identity is the seq of the event that reported it, the same
    // whether it is read from the snapshot or from the event itself.
    failedSeq: snapshot.error ? (snapshot.error.failureSeq ?? snapshot.seq) : 0,
    media: Object.fromEntries(
      Object.entries(snapshot.media ?? {}).map(([elementId, state]) => [
        elementId,
        { ...state, seq: state.failureSeq ?? snapshot.seq },
      ]),
    ),
  };
}

/**
 * Where to follow a snapshot's event log from. The outline items stream as
 * events only (the snapshot has no outline until it is ready), so a run that
 * has not reached its outline is followed from its first event and its view
 * rebuilt from the log; any other run from the snapshot's `seq`.
 */
export function followFrom(snapshot: RunSnapshot): { view: RunView; after: number } {
  const view = viewFromSnapshot(snapshot);
  if (snapshot.state === 'preparing' || snapshot.state === 'outlining') {
    return {
      view: { ...view, seq: 0, streamingOutlines: [], outline: null, materialsAnalyzed: false },
      after: 0,
    };
  }
  return { view, after: snapshot.seq };
}

function sceneIndexOf(step: unknown): number | null {
  if (typeof step !== 'string') return null;
  const match = /^scene:(\d+):/.exec(step);
  return match ? Number(match[1]) : null;
}

function withoutKey<T>(record: Record<number, T>, key: number): Record<number, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function applyRunEvent(view: RunView, event: RunEvent): RunView {
  if (event.seq <= view.seq) return view;
  const next: RunView = { ...view, seq: event.seq };
  const data = event.data;
  switch (event.type) {
    case 'state': {
      next.state = data.state as GenerationRunState;
      next.step = (data.step as string | null | undefined) ?? null;
      if (next.state !== 'paused') next.error = null;
      return next;
    }
    case 'step_started': {
      next.step = data.step as string;
      next.stepStartedSeq = event.seq;
      // A scene that runs again is no longer one the run went on past.
      const index = sceneIndexOf(data.step);
      if (index !== null) next.skippedScenes = withoutKey(next.skippedScenes, index);
      return next;
    }
    case 'step_failed': {
      const step = (data.step as string | undefined) ?? null;
      const message = String(data.message ?? '');
      if (data.continuing === true) {
        const index = sceneIndexOf(step);
        if (index !== null) next.skippedScenes = { ...next.skippedScenes, [index]: message };
        return next;
      }
      next.error = {
        step,
        message,
        ...(typeof data.errorCode === 'string' ? { errorCode: data.errorCode } : {}),
        ...(typeof data.statusCode === 'number' ? { statusCode: data.statusCode } : {}),
      };
      next.failedSeq = event.seq;
      return next;
    }
    case 'step_completed':
      if (data.step === 'material-analysis') next.materialsAnalyzed = true;
      return next;
    case 'material_kinds':
      next.materialKinds = Array.isArray(data.kinds)
        ? data.kinds.map((kind) => (kind === 'media' ? 'media' : 'document'))
        : null;
      return next;
    case 'material_truncated':
      next.materialTruncated = {
        ...(typeof data.textChars === 'number' ? { textChars: data.textChars } : {}),
        ...(data.images && typeof data.images === 'object'
          ? { images: data.images as { total: number; max: number } }
          : {}),
      };
      return next;
    case 'research_sources': {
      const sources = Array.isArray(data.sources) ? data.sources : [];
      next.researchSources = sources.flatMap((source) => {
        const record = source as { title?: unknown; url?: unknown };
        return typeof record.url === 'string'
          ? [
              {
                title: typeof record.title === 'string' ? record.title : record.url,
                url: record.url,
              },
            ]
          : [];
      });
      return next;
    }
    case 'outline_reset':
      next.streamingOutlines = [];
      next.outlineRetrying = true;
      return next;
    case 'outline_item': {
      const index = typeof data.index === 'number' ? data.index : next.streamingOutlines.length;
      const items = [...next.streamingOutlines];
      items[index] = data.outline as SceneOutline;
      next.streamingOutlines = items.filter(Boolean);
      next.outlineRetrying = false;
      return next;
    }
    case 'outline_ready': {
      const outline = data.outline as RunView['outline'];
      if (outline) {
        next.outline = { ...outline, revision: Number(data.revision) };
        next.streamingOutlines = outline.outlines;
        next.progress = { ...next.progress, scenesTotal: outline.outlines.length };
      }
      next.outlineRetrying = false;
      return next;
    }
    case 'outline_confirmed': {
      // An edited outline's items are in the snapshot, not in the event: the
      // caller reads the snapshot for them.
      if (next.outline) next.outline = { ...next.outline, revision: Number(data.revision) };
      return next;
    }
    case 'agents': {
      const agents = Array.isArray(data.agents) ? (data.agents as GeneratedAgentConfig[]) : [];
      // Generated rosters carry an avatar; preset agents are not revealed.
      next.generatedAgents =
        agents.length > 0 && agents.every((agent) => typeof agent.avatar === 'string')
          ? agents
          : null;
      return next;
    }
    case 'course_created':
      next.stageId = (data.stageId as string) ?? next.stageId;
      return next;
    case 'scene_ready': {
      const index = Number(data.index);
      const isNew = !(index in next.readyScenes);
      next.readyScenes = { ...next.readyScenes, [index]: String(data.sceneId) };
      next.skippedScenes = withoutKey(next.skippedScenes, index);
      if (isNew) {
        const completed = next.progress.scenesCompleted + 1;
        next.progress = {
          ...next.progress,
          scenesCompleted:
            next.progress.scenesTotal > 0
              ? Math.min(completed, next.progress.scenesTotal)
              : completed,
        };
      }
      return next;
    }
    case 'completed':
      next.stageId = (data.stageId as string) ?? next.stageId;
      return next;
    case 'ended':
      return next;
    case 'media': {
      const { elementId, ...state } = data as { elementId?: unknown } & GenerationRunMediaState;
      if (typeof elementId !== 'string') return next;
      next.media = { ...next.media, [elementId]: { ...state, seq: event.seq } };
      return next;
    }
    default:
      return next;
  }
}

/** The outline the browser shows: the ready outline once there is one, the streamed items before. */
export function visibleOutlines(view: RunView): SceneOutline[] {
  return view.outline?.outlines ?? view.streamingOutlines;
}
