import { SlotDisabledError, SlotUnassignedError } from '@/lib/server/model-config/runtime';
import { resolveMediaSlot, type MediaConnection } from '@/lib/server/model-config/media';

/**
 * The webFetch slot's reader, following the media resolver's failure rules:
 * disabled or unassigned omits the tool; a stale reference fails loudly.
 * Kept apart from the reader itself so callers can check the slot without
 * loading the extraction stack.
 */
export async function resolveWebFetchCapability(
  workspaceId: string | null,
): Promise<MediaConnection | null> {
  try {
    return await resolveMediaSlot('webFetch', { workspaceId });
  } catch (error) {
    if (error instanceof SlotDisabledError || error instanceof SlotUnassignedError) return null;
    throw error;
  }
}
