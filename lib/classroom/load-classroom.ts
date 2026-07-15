import { restoreAgentSelection } from '@/lib/orchestration/registry/agent-selection';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { getActionsForRole } from '@/lib/orchestration/registry/types';
import { applyHydratedClassroomFallbackScenes } from '@/lib/classroom/pbl-fallback-hydration';
import type { TTSProviderId } from '@/lib/audio/types';
import type { VoiceDesign } from '@/lib/audio/voice-design';
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';
import { useStageStore, type StageSceneLoadToken } from '@/lib/store/stage';
import type { GeneratedAgentRecord, MediaFileRecord } from '@/lib/utils/database';
import type { Scene, Stage } from '@/lib/types/stage';

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

export interface RunClassroomLoadArgs<TMediaTasks = unknown, TGeneratedAgentRecord = unknown> {
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
  saveGeneratedAgents: (
    stageId: string,
    agents: NonNullable<Stage['generatedAgentConfigs']>,
  ) => Promise<unknown>;
  loadRestoredMediaTasks: (stageId: string) => Promise<TMediaTasks>;
  applyRestoredMediaTasks: (tasks: TMediaTasks) => void;
  discardRestoredMediaTasks: (tasks: TMediaTasks) => void;
  loadGeneratedAgentRecords: (stageId: string) => Promise<TGeneratedAgentRecord[]>;
  applyGeneratedAgentRecords: (records: TGeneratedAgentRecord[]) => string[];
  getSettings: () => ClassroomLoadSettings;
  getAgent: (agentId: string) => AgentLookupResult | undefined;
  restoreAgentSelection: typeof restoreAgentSelection;
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  log: Logger;
}

export async function runClassroomLoad<TMediaTasks = unknown, TGeneratedAgentRecord = unknown>({
  classroomId,
  loadToken,
  isCurrent,
  loadFromStorage,
  getCurrentStage,
  fetchClassroom,
  applyFallbackScenes,
  saveGeneratedAgents,
  loadRestoredMediaTasks,
  applyRestoredMediaTasks,
  discardRestoredMediaTasks,
  loadGeneratedAgentRecords,
  applyGeneratedAgentRecords,
  getSettings,
  getAgent,
  restoreAgentSelection: restoreSelection,
  setError,
  setLoading,
  log,
}: RunClassroomLoadArgs<TMediaTasks, TGeneratedAgentRecord>): Promise<void> {
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

        if (stage.generatedAgentConfigs?.length) {
          if (!isCurrent()) return;
          await saveGeneratedAgents(stage.id, stage.generatedAgentConfigs);
          if (!isCurrent()) return;
          log.info('Hydrated server-generated agents for stage:', stage.id);
        }
      }
    }

    if (!isCurrent()) return;
    const mediaTasks = await loadRestoredMediaTasks(classroomId);
    if (!isCurrent()) {
      discardRestoredMediaTasks(mediaTasks);
      return;
    }
    applyRestoredMediaTasks(mediaTasks);

    if (!isCurrent()) return;
    const generatedAgentRecords = await loadGeneratedAgentRecords(classroomId);
    if (!isCurrent()) return;
    const generatedAgentIds = applyGeneratedAgentRecords(generatedAgentRecords);

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
  options: { persist?: boolean } = {},
): void {
  const nextScenes = [...scenes];
  useStageStore.setState((state) => ({
    stage,
    scenes: nextScenes,
    currentSceneId: nextScenes[0]?.id ?? null,
    chats: [],
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

export async function loadGeneratedAgentRecordsFromDB(
  stageId: string,
): Promise<GeneratedAgentRecord[]> {
  const { getGeneratedAgentsByStageId } = await import('@/lib/utils/database');
  return getGeneratedAgentsByStageId(stageId);
}

export async function saveGeneratedAgentsForCurrentLoad(
  stageId: string,
  agents: NonNullable<Stage['generatedAgentConfigs']>,
  isCurrent: () => boolean,
): Promise<string[]> {
  if (!isCurrent()) return [];
  const { db } = await import('@/lib/utils/database');
  if (!isCurrent()) return [];

  const records = agents.map((agent) => ({ ...agent, stageId, createdAt: Date.now() }));
  await db.transaction('rw', db.generatedAgents, async () => {
    await db.generatedAgents.where('stageId').equals(stageId).delete();
    await db.generatedAgents.bulkPut(records);
  });
  if (!isCurrent()) return [];

  const registry = useAgentRegistry.getState();
  for (const agent of registry.listAgents()) {
    if (agent.isGenerated) registry.deleteAgent(agent.id);
  }

  for (const record of records) {
    const { voiceConfig, ...rest } = record as (typeof records)[number] & {
      voiceConfig?: { providerId: string; voiceId: string };
      voiceDesign?: VoiceDesign;
    };
    registry.addAgent({
      ...rest,
      allowedActions: getActionsForRole(record.role),
      isDefault: false,
      isGenerated: true,
      boundStageId: stageId,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.createdAt),
      ...(voiceConfig
        ? {
            voiceConfig: {
              providerId: voiceConfig.providerId as TTSProviderId,
              voiceId: voiceConfig.voiceId,
            },
          }
        : {}),
    });
  }

  void import('@/lib/audio/agent-voice')
    .then((module) =>
      module.warmUpAgentVoices(registry.listAgents().filter((agent) => agent.isGenerated)),
    )
    .catch(() => undefined);

  return records.map((record) => record.id);
}

export function applyGeneratedAgentRecordsToRegistry(
  records: readonly GeneratedAgentRecord[],
): string[] {
  const registry = useAgentRegistry.getState();
  for (const agent of registry.listAgents()) {
    if (agent.isGenerated) {
      registry.deleteAgent(agent.id);
    }
  }

  const ids: string[] = [];
  for (const record of records) {
    registry.addAgent({
      ...record,
      allowedActions: getActionsForRole(record.role),
      isDefault: false,
      isGenerated: true,
      boundStageId: record.stageId,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.createdAt),
    });
    ids.push(record.id);
  }
  return ids;
}

export const defaultClassroomLoadDeps = {
  applyFallbackScenes: applyHydratedClassroomFallbackScenes,
  fetchClassroom: fetchClassroomFromApi,
  loadRestoredMediaTasks: loadRestoredMediaTasksFromDB,
  applyRestoredMediaTasks,
  discardRestoredMediaTasks,
  loadGeneratedAgentRecords: loadGeneratedAgentRecordsFromDB,
  applyGeneratedAgentRecords: applyGeneratedAgentRecordsToRegistry,
  restoreAgentSelection,
};
