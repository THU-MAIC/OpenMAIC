import { describe, expect, it } from 'vitest';
import {
  requestEpisodeStart,
  requestStartIndex,
  requestTrack,
} from '@/lib/workbench/request-activity';
import {
  createInitialSessionState,
  foldEvent,
  type ChatNode,
  type WorkbenchEvent,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';

const user: ChatNode = { key: 'u', kind: 'user', text: 'question', at: 10 };
const waiting: ChatNode = { key: 'w', kind: 'waiting', text: '', startedAt: 11 };

describe('the current request in the real conversation', () => {
  it('starts at the latest request and does not borrow previous exchanges', () => {
    expect(requestTrack([user, waiting], 'running', false)).toMatchObject({
      startedAt: 10,
      prompt: 'question',
      live: true,
    });
    expect(requestTrack([waiting], 'running', false)).toBeNull();
  });

  it('shows a just-created session that waits in the queue before any event', () => {
    expect(requestTrack([], 'queued', false, 'Make a course')).toMatchObject({
      prompt: 'Make a course',
      steps: [],
      live: true,
    });
    // Attaching to an existing session is not a queued request.
    expect(requestTrack([], 'connecting', false, 'Make a course')).toBeNull();
    expect(requestTrack([], 'queued', true, 'Make a course')).toBeNull();
  });

  it.each(['queued', 'connecting'] as const)('is live while %s', (status) => {
    expect(requestTrack([user, waiting], status, false)?.live).toBe(true);
  });

  it('is never produced during a replay, and settles with the run', () => {
    expect(requestTrack([user, waiting], 'running', true)).toBeNull();
    const answered: ChatNode[] = [user, { key: 'a', kind: 'assistant', text: 'answer' }];
    for (const status of ['succeeded', 'failed', 'cancelled', 'idle'] as const)
      expect(requestTrack(answered, status, false)?.live).toBe(false);
  });

  it('an answer to the agent’s question continues the request that asked it', () => {
    const chat: ChatNode[] = [
      user,
      { key: 'a', kind: 'assistant', text: 'Plan' },
      { key: 'q', kind: 'question', text: 'OK?', at: 20, questionAnswered: true },
      { key: 'u2', kind: 'user', text: 'Yes', at: 30 },
    ];
    expect(requestStartIndex(chat)).toBe(3);
    expect(requestEpisodeStart(chat)).toBe(0);
    expect(requestTrack(chat, 'running', false)?.question).toMatchObject({
      ts: 20,
      planText: 'Plan',
      answeredAt: 30,
    });
  });
});

function folding() {
  let id = 0;
  let state: WorkbenchFold = createInitialSessionState();
  return {
    fold(type: string, data: unknown = {}) {
      const frame: WorkbenchEvent = { id: ++id, ts: id * 100, attempt: 1, type, data };
      state = foldEvent(state, frame);
      return state;
    },
    track(status = state.status, replaying = false) {
      return requestTrack(state.chat, status, replaying);
    },
  };
}

it('follows real lifecycle frames: internal turn_end is not answer completion', () => {
  const run = folding();
  run.fold('session_start', { prompt: 'Explain light' });
  expect(run.track()?.live).toBe(true);
  run.fold('turn_end');
  expect(run.track()?.live).toBe(true);
  run.fold('message_start', { message: { role: 'assistant', content: [] } });
  run.fold('message_end', {
    message: { role: 'assistant', content: [{ type: 'text', text: 'Because…' }] },
  });
  run.fold('agent_end');
  run.fold('session_end', { status: 'succeeded' });
  expect(run.track()?.live).toBe(false);
});

it('keeps a running tool through a steer but separates a queued new request', () => {
  const run = folding();
  run.fold('session_start', { prompt: 'Make a course' });
  run.fold('tool_execution_start', {
    toolCallId: 'scene',
    toolName: 'generate_scene',
    args: { stageId: 'course', order: 1 },
  });
  run.fold('user_message', { text: 'Use simpler words', delivery: 'steer' });
  expect(run.track()?.steps.map((step) => step.id)).toEqual(['scene']);
  run.fold('agent_end');
  run.fold('session_end', { status: 'succeeded' });
  run.fold('user_message', { text: 'Next question', delivery: 'queued' });
  expect(run.track()).toMatchObject({ prompt: 'Next question', steps: [], live: true });
});

describe('waiting for the user to confirm a plan (ask_user)', () => {
  const asked = () => {
    const run = folding();
    run.fold('session_start', { prompt: 'Make a course on photosynthesis' });
    run.fold('message_start', { message: { role: 'assistant', content: [] } });
    run.fold('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'Plan: 1. Light 2. Quiz' }] },
    });
    run.fold('tool_execution_start', { toolCallId: 'ask', toolName: 'ask_user', args: {} });
    run.fold('user_question', {
      question: 'Shall I build this plan?',
      options: [
        { id: 'yes', label: 'Go ahead' },
        { id: 'change', label: 'Change it' },
      ],
    });
    run.fold('tool_execution_end', { toolCallId: 'ask', toolName: 'ask_user', result: {} });
    run.fold('agent_end');
    run.fold('session_end', { status: 'succeeded' });
    return run;
  };

  it('keeps the open question live after ask_user ends the run', () => {
    const track = asked().track();
    expect(track?.live).toBe(true);
    expect(track?.question?.node.text).toBe('Shall I build this plan?');
    expect(track?.question?.planText).toBe('Plan: 1. Light 2. Quiz');
    expect(track?.question?.answeredAt).toBeNull();
  });

  it('carries the answered question into the run it starts', () => {
    const run = asked();
    run.fold('user_message', { text: 'Go ahead', delivery: 'queued' });
    run.fold('session_resumed', { reason: 'follow_up' });
    const track = run.track();
    expect(track?.prompt).toBe('Make a course on photosynthesis');
    expect(track?.question?.answeredAt).not.toBeNull();
    expect(track?.live).toBe(true);
  });

  it('settles once that run ends, and is never produced in a replay', () => {
    const run = asked();
    expect(run.track(undefined, true)).toBeNull();
    run.fold('user_message', { text: 'Go ahead', delivery: 'queued' });
    run.fold('session_resumed', { reason: 'follow_up' });
    run.fold('agent_end');
    run.fold('session_end', { status: 'succeeded' });
    expect(run.track()?.live).toBe(false);
  });
});
