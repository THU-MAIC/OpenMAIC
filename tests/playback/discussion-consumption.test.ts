import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import type { Action, DiscussionAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { PlaybackSnapshot } from '@/lib/playback/types';

function discussion(id: string, agentId?: string): Action {
  return {
    id,
    type: 'discussion',
    topic: `topic-${id}`,
    prompt: `prompt-${id}`,
    agentId,
  } as unknown as DiscussionAction;
}

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

function createActionEngine(): ActionEngine {
  return {
    execute: vi.fn(async () => {}),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  } as unknown as ActionEngine;
}

function createAudioPlayer(): AudioPlayer {
  return {
    play: vi.fn(async () => false),
    onEnded: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
  } as unknown as AudioPlayer;
}

/**
 * Every discussion-consumption path must publish a progress snapshot carrying
 * the consumed id: `onProgress` otherwise only fires BEFORE the discussion
 * action executes, and a discussion is the scene's last action, so persistence
 * would never observe the fact (the P0 found in final review).
 */
describe('discussion consumption emits a progress snapshot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function snapshotsWith(onProgress: ReturnType<typeof vi.fn>, id: string): PlaybackSnapshot[] {
    return (onProgress.mock.calls as [PlaybackSnapshot][])
      .map(([snapshot]) => snapshot)
      .filter((snapshot) => snapshot.consumedDiscussions.includes(id));
  }

  it('publishes the fact when an unselected agent auto-skips the discussion', async () => {
    const onProgress = vi.fn();
    const engine = new PlaybackEngine(
      [scene([discussion('disc-auto', 'agent-x')])],
      createActionEngine(),
      createAudioPlayer(),
      { onProgress, isAgentSelected: () => false },
    );

    engine.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(snapshotsWith(onProgress, 'disc-auto').length).toBeGreaterThan(0);
  });

  it('publishes the fact when the user skips the proactive card', async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const engine = new PlaybackEngine(
      [scene([discussion('disc-skip')])],
      createActionEngine(),
      createAudioPlayer(),
      { onProgress },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(4000);
    engine.skipDiscussion();

    expect(snapshotsWith(onProgress, 'disc-skip').length).toBeGreaterThan(0);
  });

  it('publishes the fact when the user joins the discussion', async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const engine = new PlaybackEngine(
      [scene([discussion('disc-join')])],
      createActionEngine(),
      createAudioPlayer(),
      { onProgress },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(4000);
    engine.confirmDiscussion();

    expect(snapshotsWith(onProgress, 'disc-join').length).toBeGreaterThan(0);
  });
});
