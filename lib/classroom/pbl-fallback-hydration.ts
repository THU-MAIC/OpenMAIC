import { migrateScene } from '@/lib/edit/slide-schema';
import {
  hydratePBLScenesFromRuntime,
  type HydratePBLProjectArgs,
} from '@/lib/pbl/v2/runtime/hydration';
import { isCurrentStageSceneLoadToken, type StageSceneLoadToken } from '@/lib/store/stage';
import type { ChatSession } from '@/lib/types/chat';
import type { Scene, Stage } from '@/lib/types/stage';
import {
  loadChatSessions,
  type ChatStorageReadOptions,
  type ChatStorageSnapshot,
} from '@/lib/utils/chat-storage';

export async function hydrateClassroomFallbackScenes(
  stageId: string,
  scenes: readonly Scene[],
  options: Pick<HydratePBLProjectArgs, 'store' | 'kv' | 'learnerKey'> = {},
): Promise<Scene[]> {
  return hydratePBLScenesFromRuntime(stageId, scenes.map(migrateScene), options);
}

export interface ClassroomFallbackChatState {
  chats: ChatSession[];
  chatSnapshot: ChatStorageSnapshot;
}

export async function hydrateClassroomFallbackChats(
  stageId: string,
  options: ChatStorageReadOptions = {},
): Promise<ClassroomFallbackChatState> {
  let chatSnapshot: ChatStorageSnapshot = { sessions: [], restoreMarker: undefined };
  try {
    const chats = await loadChatSessions(stageId, {
      ...options,
      onSnapshot: (snapshot) => {
        chatSnapshot = snapshot;
        options.onSnapshot?.(snapshot);
      },
    });
    return { chats, chatSnapshot };
  } catch (error) {
    console.warn(`Failed to hydrate runtime chats for server fallback stage ${stageId}:`, error);
    return { chats: [], chatSnapshot };
  }
}

export interface ApplyHydratedClassroomFallbackScenesArgs {
  loadToken: StageSceneLoadToken;
  isCurrent?: () => boolean;
  stage: Stage;
  scenes: readonly Scene[];
  hydrateScenes?: (stageId: string, scenes: readonly Scene[]) => Promise<Scene[]>;
  hydrateChats?: (stageId: string) => Promise<ClassroomFallbackChatState>;
  applyStageAndScenes: (stage: Stage, scenes: Scene[], options: ClassroomFallbackChatState) => void;
}

export async function applyHydratedClassroomFallbackScenes({
  loadToken,
  isCurrent = () => true,
  stage,
  scenes,
  hydrateScenes = hydrateClassroomFallbackScenes,
  hydrateChats = async () => ({
    chats: [],
    chatSnapshot: { sessions: [], restoreMarker: null },
  }),
  applyStageAndScenes,
}: ApplyHydratedClassroomFallbackScenesArgs): Promise<boolean> {
  const [hydrated, chatState] = await Promise.all([
    hydrateScenes(stage.id, scenes),
    hydrateChats(stage.id),
  ]);
  if (!isCurrent() || !isCurrentStageSceneLoadToken(loadToken)) {
    return false;
  }
  applyStageAndScenes(stage, hydrated, chatState);
  return true;
}
