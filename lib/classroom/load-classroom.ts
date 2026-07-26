import { restoreAgentSelection } from '@/lib/orchestration/registry/agent-selection';
import { applyGeneratedAgentsToRegistry } from '@/lib/orchestration/registry/store';
import {
  applyHydratedClassroomFallbackScenes,
  hydrateClassroomFallbackChats,
  type ApplyHydratedClassroomFallbackScenesArgs,
} from '@/lib/classroom/pbl-fallback-hydration';
import type { ChatStorageSnapshot } from '@/lib/utils/chat-storage';
import type { ChatSession } from '@/lib/types/chat';
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';
import {
  markStagePersistenceDirty,
  useStageStore,
  type StageSceneLoadToken,
} from '@/lib/store/stage';
import type { MediaFileRecord } from '@/lib/utils/database';
import { unmarkStageDeleted } from '@/lib/utils/deleted-stages';
import type { GeneratedAgentConfig, Scene, Stage } from '@/lib/types/stage';

export interface ClassroomPayload {
  stage: Stage;
  scenes: Scene[];
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface ClassroomLoadSettings {
  agentMode: 'preset' | 'auto';
  selectedAgentIds: string[];
  agentSelectionIsUserSet: boolean;
  setAgentMode: (mode: 'preset' | 'auto') => void;
  setSelectedAgentIds: (ids: string[]) => void;
  setAgentSelectionIsUserSet: (isUserSet: boolean) => void;
}

interface AgentLookupResult {
  isGenerated?: boolean;
}

export interface RunClassroomLoadArgs<TMediaTasks = unknown> {
  classroomId: string;
  loadToken: StageSceneLoadToken;
  isCurrent: () => boolean;
  loadFromStorage: (classroomId: string, loadToken: StageSceneLoadToken) => Promise<void>;
  getCurrentStage: () => Stage | null;
  fetchClassroom: (classroomId: string) => Promise<ClassroomPayload | null>;
  applyFallbackScenes: (args: {
    loadToken: StageSceneLoadToken;
    stage: Stage;
    scenes: readonly Scene[];
  }) => Promise<boolean>;
  loadRestoredMediaTasks: (stageId: string) => Promise<TMediaTasks>;
  applyRestoredMediaTasks: (tasks: TMediaTasks) => void;
  discardRestoredMediaTasks: (tasks: TMediaTasks) => void;
  /**
   * Read the legacy per-stage roster mirror (read-only migration source) as
   * contract-shaped configs. Used only to backfill a document whose configs
   * predate the single-source model (missing roster or missing voice fields).
   * Returns `null` when the read FAILED (as opposed to an empty mirror), so
   * the caller can retry on a later load instead of memoizing the failure.
   */
  loadLegacyAgentFallbacks: (stageId: string) => Promise<GeneratedAgentConfig[] | null>;
  /** Commit lazily migrated configs onto the in-memory stage + mark it dirty. */
  commitMigratedAgentConfigs: (stageId: string, configs: GeneratedAgentConfig[]) => void;
  /** Synchronously mirror the roster into the in-memory agent registry. */
  applyGeneratedAgents: (stageId: string, configs: readonly GeneratedAgentConfig[]) => string[];
  getSettings: () => ClassroomLoadSettings;
  getAgent: (agentId: string) => AgentLookupResult | undefined;
  restoreAgentSelection: typeof restoreAgentSelection;
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  log: Logger;
}

/**
 * Stages whose legacy-mirror probe SUCCEEDED and came back with nothing to
 * merge this session. `rosterNeedsLegacyFallback` cannot distinguish
 * "predates voice persistence" from "the producer never bound a voice"
 * (server-generated classrooms emit voiceless rosters by design), so without
 * this memo such classrooms would re-query the mirror on every load forever.
 * A FAILED mirror read is never memoized — the next load retries the probe.
 * Session-scoped on purpose: no persistent marker is introduced for a pure
 * read optimization.
 */
const fruitlessLegacyProbeStageIds = new Set<string>();

/** Test hook: forget which stages already had a fruitless legacy-mirror probe. */
export function resetLegacyAgentFallbackProbes(): void {
  fruitlessLegacyProbeStageIds.clear();
}

export async function runClassroomLoad<TMediaTasks = unknown>({
  classroomId,
  loadToken,
  isCurrent,
  loadFromStorage,
  getCurrentStage,
  fetchClassroom,
  applyFallbackScenes,
  loadRestoredMediaTasks,
  applyRestoredMediaTasks,
  discardRestoredMediaTasks,
  loadLegacyAgentFallbacks,
  commitMigratedAgentConfigs,
  applyGeneratedAgents,
  getSettings,
  getAgent,
  restoreAgentSelection: restoreSelection,
  setError,
  setLoading,
  log,
}: RunClassroomLoadArgs<TMediaTasks>): Promise<void> {
  try {
    await loadFromStorage(classroomId, loadToken);
    if (!isCurrent()) return;

    if (!getCurrentStage()) {
      log.info('No IndexedDB data, trying server-side storage for:', classroomId);
      const classroom = await fetchClassroom(classroomId);
      if (!isCurrent()) return;

      if (classroom) {
        const { stage, scenes } = classroom;
        const applied = await applyFallbackScenes({ loadToken, stage, scenes });
        if (!isCurrent()) return;
        if (!applied) {
          log.info('Stage changed during server-side fallback hydration, skipping load:', {
            requestedStageId: stage.id,
            latestStageId: getCurrentStage()?.id,
          });
          return;
        }
        log.info('Loaded from server-side storage:', classroomId);
      }
    }

    if (!isCurrent()) return;
    const mediaTasks = await loadRestoredMediaTasks(classroomId);
    if (!isCurrent()) {
      discardRestoredMediaTasks(mediaTasks);
      return;
    }
    applyRestoredMediaTasks(mediaTasks);

    // ── Roster hydration: the stage document is the source of truth ──
    // The legacy IndexedDB mirror is consulted as a read-only, per-stage
    // migration probe: it backfills a roster (or its voice fields) written
    // before the roster was persisted on the document. A successful merge is
    // committed back onto the stage so the next flush makes it durable, after
    // which subsequent loads find nothing to merge. A fruitless probe (no
    // mirror rows, or nothing mergeable — e.g. server-generated rosters whose
    // producer never bound a voice) is remembered for the session so the
    // mirror is not re-queried on every load of a classroom that has nothing
    // to migrate. A FAILED mirror read is neither merged nor remembered — the
    // next load retries the probe.
    if (!isCurrent()) return;
    const stageForRoster = getCurrentStage();
    // The absent-vs-empty distinction is load-bearing and deliberately NOT
    // collapsed here: `undefined` means the document predates roster
    // persistence (probe the mirror, possibly lifting a whole roster), while
    // an explicit `[]` is an authoritative empty roster that must never be
    // resurrected from the stale read-only mirror.
    const documentConfigs =
      stageForRoster?.id === classroomId ? stageForRoster.generatedAgentConfigs : undefined;
    let effectiveConfigs = documentConfigs ?? [];
    if (
      stageForRoster?.id === classroomId &&
      rosterNeedsLegacyFallback(documentConfigs) &&
      !fruitlessLegacyProbeStageIds.has(classroomId)
    ) {
      const fallbacks = await loadLegacyAgentFallbacks(classroomId);
      // The registry is a global singleton: after any await, re-check that this
      // load is still current before letting the merged roster land anywhere.
      if (!isCurrent()) return;
      // `null` = the mirror read FAILED (not "mirror is empty"). Skip both
      // the merge and the memo so the next load retries the probe once
      // storage recovers — a transient IndexedDB error must not become a
      // session-long migration skip.
      if (fallbacks !== null) {
        const merged = mergeLegacyAgentFallbacks(documentConfigs ?? [], fallbacks);
        if (merged.changed) {
          effectiveConfigs = merged.configs;
          commitMigratedAgentConfigs(classroomId, merged.configs);
        } else {
          // The read SUCCEEDED and confirmed nothing to migrate for this
          // stage; don't probe again this session. (A successful merge is NOT
          // memoized: if its flush fails, the next load must retry the merge
          // until the document carries the voices.)
          fruitlessLegacyProbeStageIds.add(classroomId);
        }
      }
    }

    if (!isCurrent()) return;
    const generatedAgentIds = applyGeneratedAgents(classroomId, effectiveConfigs);

    if (!isCurrent()) return;
    const settings = getSettings();
    const { selection: next, isUserSet } = restoreSelection({
      persisted: { mode: settings.agentMode, selectedAgentIds: settings.selectedAgentIds },
      persistedIsUserSet: settings.agentSelectionIsUserSet,
      generatedAgentIds,
      stageAgentIds: getCurrentStage()?.agentIds,
      isPresetAgent: (id) => {
        const agent = getAgent(id);
        return !!agent && !agent.isGenerated;
      },
    });

    if (!isCurrent()) return;
    if (next.mode !== settings.agentMode) settings.setAgentMode(next.mode);
    if (next.selectedAgentIds !== settings.selectedAgentIds) {
      settings.setSelectedAgentIds(next.selectedAgentIds);
    }
    if (isUserSet !== settings.agentSelectionIsUserSet) {
      settings.setAgentSelectionIsUserSet(isUserSet);
    }
  } catch (error) {
    log.error('Failed to load classroom:', error);
    if (isCurrent()) {
      setError(error instanceof Error ? error.message : 'Failed to load classroom');
    }
  } finally {
    if (isCurrent()) {
      setLoading(false);
    }
  }
}

export async function fetchClassroomFromApi(classroomId: string): Promise<ClassroomPayload | null> {
  const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
  if (!res.ok) return null;

  const json = (await res.json()) as {
    success?: boolean;
    classroom?: ClassroomPayload;
  };
  if (!json.success || !json.classroom) return null;
  return json.classroom;
}

export function applyClassroomStageAndScenes(
  stage: Stage,
  scenes: readonly Scene[],
  options: {
    persist?: boolean;
    chats?: ChatSession[];
    chatSnapshot?: ChatStorageSnapshot;
  } = {},
): void {
  // Explicit document (re)creation point: deletion only removes client-side
  // data, so revisiting the classroom URL restores the server copy under the
  // SAME id. Lift any same-session deleted flag before the store write, or
  // every subsequent edit of the restored classroom would be silently dropped
  // until a reload. This is a deliberate restore, not an in-flight flush —
  // exactly the distinction `deleted-stages.ts` requires. The deletion EPOCH
  // stays bumped: a pre-delete flush still in flight remains permanently
  // stale and cannot overwrite the restored document, while the
  // `saveToStorage` below (and every later edit) captures the current epoch
  // and persists normally.
  unmarkStageDeleted(stage.id);
  const nextScenes = [...scenes];
  useStageStore.setState((state) => ({
    stage,
    scenes: nextScenes,
    currentSceneId: nextScenes[0]?.id ?? null,
    chats: options.chats ?? [],
    chatSnapshot: options.chatSnapshot ?? { sessions: [], restoreMarker: null },
    generationComplete: false,
    generationEpoch: state.generationEpoch + 1,
    mode: 'playback',
  }));
  if (options.persist !== false) {
    void useStageStore.getState().saveToStorage();
  }
}

export async function loadRestoredMediaTasksFromDB(
  stageId: string,
): Promise<Record<string, MediaTask>> {
  try {
    const { db } = await import('@/lib/utils/database');
    const records = await db.mediaFiles.where('stageId').equals(stageId).toArray();
    return buildRestoredMediaTasks(stageId, records);
  } catch {
    return {};
  }
}

export function buildRestoredMediaTasks(
  stageId: string,
  records: readonly MediaFileRecord[],
): Record<string, MediaTask> {
  const restored: Record<string, MediaTask> = {};
  for (const rec of records) {
    const elementId = rec.id.includes(':') ? rec.id.split(':').slice(1).join(':') : rec.id;
    const params = JSON.parse(rec.params || '{}');

    if (rec.error) {
      restored[elementId] = {
        elementId,
        type: rec.type,
        status: 'failed',
        prompt: rec.prompt,
        params,
        error: rec.error,
        errorCode: rec.errorCode,
        retryCount: 0,
        stageId,
      };
      continue;
    }

    const blob = rec.blob.type ? rec.blob : new Blob([rec.blob], { type: rec.mimeType });
    restored[elementId] = {
      elementId,
      type: rec.type,
      status: 'done',
      prompt: rec.prompt,
      params,
      objectUrl: URL.createObjectURL(blob),
      poster: rec.poster ? URL.createObjectURL(rec.poster) : undefined,
      retryCount: 0,
      stageId,
    };
  }
  return restored;
}

export function applyRestoredMediaTasks(tasks: Record<string, MediaTask>): void {
  if (Object.keys(tasks).length === 0) return;
  useMediaGenerationStore.setState((state) => ({
    tasks: { ...state.tasks, ...tasks },
  }));
}

export function discardRestoredMediaTasks(tasks: Record<string, MediaTask>): void {
  for (const task of Object.values(tasks)) {
    if (task.objectUrl) URL.revokeObjectURL(task.objectUrl);
    if (task.poster) URL.revokeObjectURL(task.poster);
  }
}

/**
 * True when the persisted roster MAY still need the legacy mirror consulted.
 * The absent-vs-empty distinction matters:
 *
 * - `undefined` (no roster field on the document) → the document may predate
 *   roster persistence entirely; the mirror may hold the whole roster, so
 *   probe it (the full-lift branch of `mergeLegacyAgentFallbacks`).
 * - `[]` (an explicitly persisted empty roster) → authoritative; never probe.
 *   No current writer produces `[]` (the roster editor enforces a non-empty
 *   roster, and import/generation only write the field when non-empty), but
 *   any future writer that does must not have its empty roster resurrected
 *   from the stale read-only mirror on every load.
 * - Non-empty with an agent missing both voice fields → the voice may live
 *   only in the mirror, but can also mean the producer never bound one
 *   (server-generated rosters are voiceless by design). Callers pair this
 *   check with the per-session fruitless-probe memo so the second case does
 *   not re-query the mirror on every load.
 */
export function rosterNeedsLegacyFallback(
  configs: readonly GeneratedAgentConfig[] | undefined,
): boolean {
  if (configs === undefined) return true;
  if (configs.length === 0) return false;
  return configs.some((config) => !config.voiceDesign && !config.voiceConfig);
}

/**
 * Merge the legacy mirror's roster into the document's configs. Pure.
 *
 * - Document configs empty + mirror has agents → lift the full mirror roster
 *   (sorted by priority desc for a stable, teacher-first order). The caller
 *   only routes a roster here when the document carried no roster field at
 *   all — an explicitly persisted `[]` never reaches the merge (see
 *   `rosterNeedsLegacyFallback`).
 * - Document configs present → only backfill missing voice fields, matched by
 *   agent id. Document fields always win; the mirror never overwrites.
 *
 * Idempotent: once the merged result is persisted, a rerun finds nothing to
 * change and reports `changed: false`.
 */
export function mergeLegacyAgentFallbacks(
  configs: readonly GeneratedAgentConfig[],
  fallbacks: readonly GeneratedAgentConfig[],
): { configs: GeneratedAgentConfig[]; changed: boolean } {
  if (configs.length === 0) {
    if (fallbacks.length === 0) return { configs: [], changed: false };
    const lifted = [...fallbacks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return { configs: lifted, changed: true };
  }

  const byId = new Map(fallbacks.map((fallback) => [fallback.id, fallback]));
  let changed = false;
  const merged = configs.map((config) => {
    if (config.voiceDesign || config.voiceConfig) return config;
    const fallback = byId.get(config.id);
    if (!fallback || (!fallback.voiceDesign && !fallback.voiceConfig)) return config;
    changed = true;
    return {
      ...config,
      ...(fallback.voiceConfig ? { voiceConfig: fallback.voiceConfig } : {}),
      ...(fallback.voiceDesign ? { voiceDesign: fallback.voiceDesign } : {}),
    };
  });
  return { configs: merged, changed };
}

/**
 * Read the legacy roster mirror for a stage as contract-shaped configs.
 * Read-only: production code only reads this table as a migration source for
 * pre-single-source classrooms (plus deletion hygiene when a stage is
 * removed); nothing writes new rows. Returns `null` when the read fails so
 * the caller can distinguish "empty mirror" (memoizable) from "read failed"
 * (retry on the next load).
 */
export async function loadLegacyAgentFallbacksFromDB(
  stageId: string,
): Promise<GeneratedAgentConfig[] | null> {
  try {
    const { getGeneratedAgentsByStageId } = await import('@/lib/utils/database');
    const records = await getGeneratedAgentsByStageId(stageId);
    return records.map((record) => {
      // Historical mirror rows spread the whole generated profile, so rows may
      // carry a voiceConfig that never made it into the declared record type.
      const voiceConfig = (record as { voiceConfig?: GeneratedAgentConfig['voiceConfig'] })
        .voiceConfig;
      return {
        id: record.id,
        name: record.name,
        role: record.role,
        persona: record.persona,
        avatar: record.avatar,
        color: record.color,
        priority: record.priority,
        ...(voiceConfig ? { voiceConfig } : {}),
        ...(record.voiceDesign ? { voiceDesign: record.voiceDesign } : {}),
      };
    });
  } catch {
    // Signal failure (vs. an empty mirror): the probe memo must not treat a
    // transient IndexedDB error as "nothing to migrate".
    return null;
  }
}

/**
 * Commit lazily migrated roster configs onto the in-memory stage and mark the
 * stage dirty so the merge becomes durable on the next scheduled flush.
 * Guarded by a stage-id re-check: a classroom switch racing this commit must
 * not write another stage's roster into the current one.
 */
export function commitMigratedAgentConfigsToStore(
  stageId: string,
  configs: GeneratedAgentConfig[],
): void {
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) return;
  useStageStore.setState({ stage: { ...state.stage, generatedAgentConfigs: configs } });
  markStagePersistenceDirty([{ kind: 'stage' }]);
}

export const defaultClassroomLoadDeps = {
  applyFallbackScenes: (args: ApplyHydratedClassroomFallbackScenesArgs) =>
    applyHydratedClassroomFallbackScenes({
      ...args,
      hydrateChats: hydrateClassroomFallbackChats,
    }),
  fetchClassroom: fetchClassroomFromApi,
  loadRestoredMediaTasks: loadRestoredMediaTasksFromDB,
  applyRestoredMediaTasks,
  discardRestoredMediaTasks,
  loadLegacyAgentFallbacks: loadLegacyAgentFallbacksFromDB,
  commitMigratedAgentConfigs: commitMigratedAgentConfigsToStore,
  applyGeneratedAgents: applyGeneratedAgentsToRegistry,
  restoreAgentSelection,
};
