import { describe, expect, it } from 'vitest';
import { requestActivity } from '@/lib/workbench/request-activity';
import type { ChatNode } from '@/lib/workbench/session-store';
const user: ChatNode = { key: 'u', kind: 'user', text: 'question' };
const waiting: ChatNode = { key: 'w', kind: 'waiting', text: '' };
describe('real conversation activity projection', () => {
  it('starts before create_stage and does not borrow previous exchanges', () => {
    expect(requestActivity([user, waiting], 'running', false)?.node).toBe(waiting);
    expect(requestActivity([waiting, user], 'running', false)).toBeNull();
  });
  it.each(['queued', 'connecting'] as const)(
    'keeps %s activity before tool execution',
    (status) => {
      expect(requestActivity([user, waiting], status, false)?.node).toBe(waiting);
    },
  );
  it('only maps matching real tools, without inventing a planning visual', () => {
    const tool: ChatNode = {
      key: 't',
      kind: 'tool',
      text: '',
      toolName: 'web_search',
      toolState: 'running',
    };
    expect(requestActivity([user, tool], 'running', false)?.stepId).toBe('web-search');
    expect(
      requestActivity([user, { ...tool, toolName: 'read' }], 'running', false)?.stepId,
    ).toBeUndefined();
    expect(
      requestActivity([user, { ...tool, toolState: 'done' }], 'running', false)?.stepId,
    ).toBeUndefined();
  });
  it('leaves replay and terminal answers in the conversation without an active preview', () => {
    expect(requestActivity([user, waiting], 'running', true)).toBeNull();
    for (const status of ['succeeded', 'failed', 'cancelled', 'idle'] as const)
      expect(requestActivity([user, waiting], status, false)).toBeNull();
  });
});

import {
  createInitialSessionState,
  foldEvent,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';
it('follows real lifecycle frames: internal turn_end is not answer completion', () => {
  let id = 0;
  const frame = (type: string, data: unknown = {}): WorkbenchEvent => ({
    id: ++id,
    ts: id,
    attempt: 1,
    type,
    data,
  });
  let state = foldEvent(
    createInitialSessionState(),
    frame('session_start', { prompt: 'Explain light' }),
  );
  expect(requestActivity(state.chat, state.status, false)).not.toBeNull();
  state = foldEvent(state, frame('turn_end'));
  expect(requestActivity(state.chat, state.status, false)).not.toBeNull();
  state = foldEvent(state, frame('agent_end'));
  state = foldEvent(state, frame('session_end', { status: 'succeeded' }));
  expect(requestActivity(state.chat, state.status, false)).toBeNull();
});

it('keeps a real running tool through steer but separates a queued new request', () => {
  let id = 0;
  const frame = (type: string, data: unknown = {}): WorkbenchEvent => ({
    id: ++id,
    ts: id,
    attempt: 1,
    type,
    data,
  });
  let state = foldEvent(
    createInitialSessionState(),
    frame('session_start', { prompt: 'Make a course' }),
  );
  state = foldEvent(
    state,
    frame('tool_execution_start', {
      toolCallId: 'scene',
      toolName: 'generate_scene',
      args: { stageId: 'course' },
    }),
  );
  const tool = requestActivity(state.chat, state.status, false)?.node;
  state = foldEvent(state, frame('user_message', { text: 'Use simpler words', delivery: 'steer' }));
  expect(requestActivity(state.chat, state.status, false)?.node).toEqual(tool);
  state = foldEvent(state, frame('agent_end'));
  state = foldEvent(state, frame('session_end', { status: 'succeeded' }));
  state = foldEvent(state, frame('user_message', { text: 'Next question', delivery: 'queued' }));
  expect(requestActivity(state.chat, 'queued', false)?.node.kind).toBe('waiting');
});
