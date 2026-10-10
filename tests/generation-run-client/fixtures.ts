import type { RunEvent, RunSnapshot } from '@/lib/generation-run-client/types';
import type { SceneOutline } from '@/lib/types/generation';

export function outline(order: number, title = `Scene ${order}`): SceneOutline {
  return {
    id: `o${order}`,
    type: 'slide',
    title,
    description: `About ${title}`,
    keyPoints: [],
    order,
  } as SceneOutline;
}

export function snapshot(patch: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: 'run-AAAAAAAAAAAAAAAA',
    state: 'preparing',
    step: null,
    seq: 1,
    input: {
      requirement: 'Photosynthesis',
      materialIds: [],
      interactive: false,
      taskEngine: false,
      agents: { mode: 'auto', presetAgentIds: [] },
      outlineReview: 'wait',
    },
    outline: null,
    agents: null,
    stageId: null,
    progress: { scenesTotal: 0, scenesCompleted: 0 },
    error: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  };
}

export function event(
  seq: number,
  type: RunEvent['type'],
  data: Record<string, unknown> = {},
): RunEvent {
  return { seq, type, data };
}
