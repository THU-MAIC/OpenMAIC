/**
 * Regression: a real session's event stream (anonymised: names, prompts and
 * page content replaced, structure and timings kept) replayed through the fold,
 * the adapter and the scheduler. Two clarifying questions, then create_stage,
 * list_voices and set_roster within five seconds, then page generation.
 *
 * The cast's reveal has to play for a viewer who watched it live AND for one
 * who opened the conversation after set_roster had already returned — the
 * second is how it went missing in a real session.
 */
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/request-preview-roster-stream.json' with { type: 'json' };
import {
  createInitialSessionState,
  foldEvent,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';
import { requestTrack } from '@/lib/workbench/request-activity';
import {
  DEFAULT_REQUEST_SCHEDULE,
  rosterRevealMs,
  scheduleRequestPreview,
} from '@/lib/workbench/request-schedule';

type Frame = [number, string, unknown];
const frames = fixture as Frame[];
const rosterAt = frames.find(
  ([, type, data]) =>
    type === 'tool_execution_end' && (data as { toolName?: string }).toolName === 'set_roster',
)![0];
const firstPageAt = frames.find(
  ([, type, data]) =>
    type === 'tool_execution_start' &&
    (data as { toolName?: string }).toolName === 'generate_scene',
)![0];

/** The fold as of `until`, as a client that has received every frame up to it. */
function foldUntil(until: number): WorkbenchFold {
  let state: WorkbenchFold = createInitialSessionState();
  frames.forEach(([ts, type, data], index) => {
    if (ts <= until) state = foldEvent(state, { id: index + 1, ts, attempt: 1, type, data });
  });
  return state;
}

function sceneAt(now: number, rosterSeenAt: number | null = null) {
  const state = foldUntil(now);
  const track = requestTrack(state.chat, 'running', false);
  if (!track) throw new Error('no track');
  return scheduleRequestPreview(track, now, DEFAULT_REQUEST_SCHEDULE, { rosterSeenAt });
}

describe('the roster reveal on a real stream', () => {
  it('has the shape the reveal reads: three agents from set_roster', () => {
    const view = sceneAt(rosterAt);
    expect(view.roster?.map((agent) => agent.role)).toEqual(['teacher', 'student', 'student']);
    expect(view.roster?.every((agent) => agent.avatar.startsWith('/avatars/'))).toBe(true);
  });

  it('plays live: assembling holds the cast until every card has flipped', () => {
    const revealEnds = rosterAt + rosterRevealMs(3);
    for (let now = rosterAt; now < Math.max(revealEnds, firstPageAt); now += 100) {
      const view = sceneAt(now);
      expect(view.scene).toBe('assembling');
      expect(view.roster).not.toBeNull();
    }
    expect(sceneAt(Math.max(revealEnds, firstPageAt) + 100).scene).toBe('generating');
  });

  it('plays for a viewer who opens the conversation after the roster was set', () => {
    const openedAt = firstPageAt + 20_000;
    // Without the viewer's memory the replay lands straight in generation.
    expect(sceneAt(openedAt).scene).toBe('generating');
    // With it, the cast is revealed first, then generation resumes.
    const reveal = sceneAt(openedAt, openedAt);
    expect(reveal.scene).toBe('assembling');
    expect(reveal.roster).toHaveLength(3);
    expect(reveal.nextChangeAt).toBe(openedAt + rosterRevealMs(3));
    expect(sceneAt(openedAt + rosterRevealMs(3), openedAt).scene).toBe('generating');
  });
});
