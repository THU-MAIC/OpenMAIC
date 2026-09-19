import type { StageMode } from '@/lib/types/stage';

interface ProPlaybackExitDeps {
  readonly stageId: string;
  readonly teardown: () => Promise<void> | void;
  readonly setMode: (mode: StageMode) => void;
  readonly replace: (href: string) => void;
  readonly onTeardownError?: (error: unknown) => void;
}

/**
 * Leave full-screen Pro playback without reviving the editor state that was
 * active before Start Learning. The standalone classroom route reads the
 * shared stage mode on its first render, so playback must be committed before
 * replacing the route. Workspace state is deliberately left intact until its
 * shell unmounts: clearing it earlier would turn `playbackOn` off while the old
 * screen is still visible and flash the editor during navigation.
 */
export async function exitProPlaybackToStandalone({
  stageId,
  teardown,
  setMode,
  replace,
  onTeardownError,
}: ProPlaybackExitDeps): Promise<void> {
  try {
    await teardown();
  } catch (error) {
    onTeardownError?.(error);
  }

  setMode('playback');
  replace(`/classroom/${encodeURIComponent(stageId)}?returnTo=home`);
}
