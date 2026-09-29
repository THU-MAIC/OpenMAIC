import { resolveMediaSlot, type MediaSlot } from '@/lib/server/model-config/media';

export interface ServerGenerationCapabilities {
  webSearch: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  tts: boolean;
}

/** Whether a media slot resolves to a provider the server can call. */
async function available(slot: MediaSlot, workspaceId: string | null): Promise<boolean> {
  try {
    const connection = await resolveMediaSlot(slot, { workspaceId });
    // Browser-native speech is the client's own, never a server capability.
    return !(slot === 'tts' && connection.providerId === 'browser-native-tts');
  } catch {
    return false;
  }
}

/**
 * The optional generation capabilities a workspace can run on this server,
 * from its capability slots (RFC #1701): a capability is available when its
 * slot resolves to a provider, and not when it is turned off or unassigned
 * (a force-disabled legacy provider counts as off, #665). `GET /api/health`
 * (the deployment alone), `GET /api/generate-classroom/capabilities` (the
 * caller's workspace) and the classroom generation pipeline (the job's owner)
 * all read this one function, so what a caller is told is available is exactly
 * what a generation job uses.
 */
export async function resolveServerGenerationCapabilities(
  workspaceId: string | null = null,
): Promise<ServerGenerationCapabilities> {
  const [webSearch, imageGeneration, videoGeneration, tts] = await Promise.all([
    available('webSearch', workspaceId),
    available('image', workspaceId),
    available('video', workspaceId),
    available('tts', workspaceId),
  ]);
  return { webSearch, imageGeneration, videoGeneration, tts };
}
