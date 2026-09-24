import type { Stage, Whiteboard } from '@/lib/types/stage';
import type { WhiteboardElementReference } from '@/lib/types/chat';

/** Use the same authority for displaying and selecting a whiteboard. An empty
 * durable board is authoritative too; it must not reveal the legacy board. */
export function getDisplayedWhiteboard(
  stage: Stage | null,
  projection: { stageId: string; lastSeq: number | null; whiteboard: Whiteboard | null } | null,
) {
  const runtimeAuthoritative =
    projection != null && projection.stageId === stage?.id && projection.lastSeq !== null;
  return {
    source: runtimeAuthoritative ? ('runtime_store' as const) : ('stage_snapshot' as const),
    whiteboard: runtimeAuthoritative ? projection.whiteboard : stage?.whiteboard?.[0],
  };
}

export function isWhiteboardReferenceAvailable(
  reference: WhiteboardElementReference,
  stage: Stage | null,
  projection: Parameters<typeof getDisplayedWhiteboard>[1],
): boolean {
  const { source, whiteboard } = getDisplayedWhiteboard(stage, projection);
  return (
    source === 'stage_snapshot' &&
    whiteboard?.id === reference.whiteboardId &&
    whiteboard.elements.filter((element) => element.id === reference.elementId).length === 1
  );
}
