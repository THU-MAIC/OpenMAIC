/**
 * Resolve the repair affordance using the same write and host boundaries as
 * the classroom. An omitted hosted callback is a denial, not an invitation to
 * route through the standalone bridge.
 */
export function mayConsumeInteractiveRepairHandoff(input: {
  readonly courseId: string | null;
  readonly isOwner: boolean | undefined;
  readonly generating: boolean;
  readonly conversationReady: boolean;
}): boolean {
  return Boolean(
    input.courseId && input.isOwner === true && !input.generating && input.conversationReady,
  );
}

export function interactiveRepairEntry(input: {
  readonly writable: boolean;
  readonly generating: boolean;
  readonly inWorkspacePane: boolean;
  readonly playback: boolean;
  readonly showingClassroom: boolean;
  readonly hostedCallback: boolean;
  readonly canHandoff: boolean;
}): 'direct' | 'handoff' | null {
  if (!input.writable || input.generating) return null;
  if (input.inWorkspacePane && !input.playback) {
    return input.showingClassroom && input.hostedCallback ? 'direct' : null;
  }
  return input.canHandoff ? 'handoff' : null;
}
