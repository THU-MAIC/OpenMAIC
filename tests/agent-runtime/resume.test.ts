/**
 * planResume: the five transcript tail states a crash can leave behind.
 *
 * These are pure-function tests of the resume planner — the state machine that
 * decides whether a reclaimed session starts fresh, continues, repairs dangling
 * tool calls, or is already done. The PG-backed claim path that feeds it is
 * covered by session-store.pg.test.ts.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';

import { planResume } from '@/lib/server/agent-runtime/resume';

const user = (text: string) => ({ role: 'user', content: text }) as unknown as AgentMessage;

const assistantText = (text: string) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  }) as unknown as AgentMessage;

const interruptedAssistant = (
  content: unknown[],
  marker: { stopReason?: string; errorMessage?: string } = { stopReason: 'aborted' },
) =>
  ({
    role: 'assistant',
    content,
    ...marker,
  }) as unknown as AgentMessage;

const assistantWithCalls = (calls: { id: string; name: string }[]) =>
  ({
    role: 'assistant',
    content: calls.map((c) => ({ type: 'toolCall', id: c.id, name: c.name, arguments: {} })),
  }) as unknown as AgentMessage;

const toolResult = (toolCallId: string, toolName = 'generate_scene') =>
  ({
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  }) as unknown as AgentMessage;

const failingToolResult = (toolCallId: string, toolName = 'ask_user') =>
  ({
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: 'nope' }],
    isError: true,
  }) as unknown as AgentMessage;

describe('planResume', () => {
  it('starts fresh on an empty or missing transcript', () => {
    expect(planResume(null)).toEqual({ kind: 'start' });
    expect(planResume([])).toEqual({ kind: 'start' });
  });

  it('continues when the tail is the user prompt (no assistant turn completed)', () => {
    const transcript = [user('build a course')];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('continue');
    if (plan.kind === 'continue') {
      expect(plan.messages).toHaveLength(1);
      expect(plan.repairedToolCalls).toEqual([]);
    }
  });

  it('continues when the tail is a tool result (tool committed, next turn never ran)', () => {
    const transcript = [
      user('build a course'),
      assistantWithCalls([{ id: 'c1', name: 'generate_outline' }]),
      toolResult('c1', 'generate_outline'),
    ];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('continue');
    if (plan.kind === 'continue') {
      expect(plan.messages).toHaveLength(3);
      expect(plan.repairedToolCalls).toEqual([]);
    }
  });

  it('settles already-complete when the tail is a SUCCESSFUL ask_user result (crash before finishSession)', () => {
    // The worker died after the ask_user checkpoint but before finishSession:
    // the runner's afterToolCall had already stopped the loop on the question,
    // so a takeover must NOT `continue()` the agent — it would answer its own
    // question and cross the consent gate.
    const transcript = [
      user('plan my week'),
      assistantWithCalls([{ id: 'c1', name: 'ask_user' }]),
      toolResult('c1', 'ask_user'),
    ];
    expect(planResume(transcript)).toEqual({ kind: 'already-complete', messages: transcript });
  });

  it('settles after a durable successful create_skill instead of creating it twice on takeover', () => {
    const transcript = [
      user('Save this method as a skill'),
      assistantWithCalls([{ id: 'c1', name: 'create_skill' }]),
      toolResult('c1', 'create_skill'),
    ];
    expect(planResume(transcript)).toEqual({ kind: 'already-complete', messages: transcript });
  });

  it('settles already-complete when ask_user shares a trailing batch with another tool (its result may not be last)', () => {
    // a mixed trailing batch residue: ask_user + another tool in one batch. The other result can
    // land AFTER ask_user's in the checkpointed transcript; the trailing
    // successful ask_user must still be recognized as the run's terminal state.
    const transcript = [
      user('plan my week'),
      assistantWithCalls([
        { id: 'c1', name: 'ask_user' },
        { id: 'c2', name: 'list_scenes' },
      ]),
      toolResult('c1', 'ask_user'),
      toolResult('c2', 'list_scenes'),
    ];
    expect(planResume(transcript)).toEqual({ kind: 'already-complete', messages: transcript });
  });

  it('still continues when the trailing ask_user result is an ERROR (the agent recovers)', () => {
    const transcript = [
      user('plan my week'),
      assistantWithCalls([{ id: 'c1', name: 'ask_user' }]),
      failingToolResult('c1', 'ask_user'),
    ];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('continue');
    if (plan.kind === 'continue') expect(plan.repairedToolCalls).toEqual([]);
  });

  it('continues when a successful ask_user is in the MIDDLE of the transcript (already answered, work followed)', () => {
    // ask_user at turn 1 was answered; the answer's run did real work after.
    // Only the TRAILING tool-result run is scanned, so this stays a normal
    // continuation point rather than a false already-complete.
    const transcript = [
      user('plan my week'),
      assistantWithCalls([{ id: 'c1', name: 'ask_user' }]),
      toolResult('c1', 'ask_user'),
      user('option B'),
      assistantWithCalls([{ id: 'c2', name: 'generate_outline' }]),
      toolResult('c2', 'generate_outline'),
    ];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('continue');
    if (plan.kind === 'continue') expect(plan.repairedToolCalls).toEqual([]);
  });

  it('reports dangling tool calls without mutating the durable recovery view', () => {
    const transcript = [
      user('build a course'),
      assistantWithCalls([
        { id: 'c1', name: 'generate_scene' },
        { id: 'c2', name: 'generate_scene' },
      ]),
      // c1 committed before the crash; c2 dangled.
      toolResult('c1'),
      assistantText('page 1 done'),
      assistantWithCalls([{ id: 'c3', name: 'generate_scene' }]),
    ];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('continue');
    if (plan.kind !== 'continue') throw new Error('unreachable');
    expect(plan.repairedToolCalls).toEqual(['c3']);
    expect(plan.messages).toEqual(transcript);
  });

  it('reports already-complete when the tail assistant message has no tool calls', () => {
    const transcript = [user('build a course'), assistantText('all done, enjoy the course')];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('already-complete');
  });

  it('continues after abort during non-empty thinking instead of settling a partial turn', () => {
    const transcript = [
      user('build a course'),
      interruptedAssistant([{ type: 'thinking', thinking: 'I should first inspect the outline' }]),
    ];
    expect(planResume(transcript)).toEqual({
      kind: 'continue',
      messages: [transcript[0]],
      repairedToolCalls: [],
    });
  });

  it('continues after abort during partial text instead of settling a partial answer', () => {
    const transcript = [
      user('build a course'),
      interruptedAssistant([{ type: 'text', text: 'I have created the first' }]),
    ];
    expect(planResume(transcript)).toEqual({
      kind: 'continue',
      messages: [transcript[0]],
      repairedToolCalls: [],
    });
  });

  it.each([
    ['error stop reason', { stopReason: 'error' }],
    ['length stop reason', { stopReason: 'length' }],
    ['non-empty errorMessage', { errorMessage: 'provider disconnected' }],
  ] as const)('strips a partial assistant frame marked by %s', (_label, marker) => {
    const transcript = [
      user('build'),
      interruptedAssistant([{ type: 'text', text: 'partial' }], marker),
    ];
    expect(planResume(transcript)).toMatchObject({ kind: 'continue', messages: [transcript[0]] });
  });

  it('continues from a durable tool result when abort happens during the next tool turn', () => {
    const transcript = [
      user('build a course'),
      assistantWithCalls([{ id: 'c1', name: 'generate_scene' }]),
      toolResult('c1'),
      interruptedAssistant([], { stopReason: 'aborted' }),
    ];
    expect(planResume(transcript)).toEqual({
      kind: 'continue',
      messages: transcript.slice(0, -1),
      repairedToolCalls: [],
    });
  });

  it('keeps a clean stop frame terminal even if its content is empty', () => {
    const completed = interruptedAssistant([], { stopReason: 'stop' });
    const transcript = [user('nothing more to add'), completed];
    expect(planResume(transcript)).toEqual({ kind: 'already-complete', messages: transcript });
  });

  it('treats unknown future content blocks as non-empty', () => {
    const futureOutput = interruptedAssistant([{ type: 'audio', data: 'durable-output' }], {
      stopReason: 'stop',
    });
    const transcript = [user('make audio'), futureOutput];
    expect(planResume(transcript)).toEqual({ kind: 'already-complete', messages: transcript });
  });

  it.each([
    ['missing text', { type: 'text' }],
    ['non-string text', { type: 'text', text: 42 }],
    ['missing thinking', { type: 'thinking' }],
    ['non-string thinking', { type: 'thinking', thinking: { partial: true } }],
  ])('conservatively preserves a malformed known block: %s', (_label, block) => {
    const malformed = interruptedAssistant([block], { stopReason: 'toolUse' });
    const transcript = [user('keep evidence'), malformed];
    expect(planResume(transcript)).toEqual({ kind: 'already-complete', messages: transcript });
  });

  it('removes consecutive empty assistant tail frames before resuming', () => {
    const empty = { role: 'assistant', content: [] } as unknown as AgentMessage;
    const whitespaceOnly = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '  \n ' },
        { type: 'text', text: '\t' },
      ],
    } as unknown as AgentMessage;
    const transcript = [user('build a course'), empty, whitespaceOnly];
    expect(planResume(transcript)).toEqual({
      kind: 'continue',
      messages: [transcript[0]],
      repairedToolCalls: [],
    });
  });

  it('starts fresh when stripping empty assistant frames empties the transcript', () => {
    const malformed = { role: 'assistant' } as unknown as AgentMessage;
    expect(planResume([malformed])).toEqual({ kind: 'start' });
  });

  it('repairs dangling calls exposed by stripping an empty assistant tail', () => {
    const transcript = [
      user('build a course'),
      assistantWithCalls([{ id: 'c1', name: 'generate_scene' }]),
      { role: 'assistant', content: [] } as unknown as AgentMessage,
    ];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('continue');
    if (plan.kind !== 'continue') throw new Error('unreachable');
    expect(plan.repairedToolCalls).toEqual(['c1']);
    expect(plan.messages).not.toContain(transcript[2]);
    expect(plan.messages).toEqual(transcript.slice(0, -1));
  });

  it('preserves a successful terminal side effect exposed by stripping an empty tail', () => {
    const transcript = [
      user('plan my week'),
      assistantWithCalls([{ id: 'c1', name: 'ask_user' }]),
      toolResult('c1', 'ask_user'),
      { role: 'assistant', content: [] } as unknown as AgentMessage,
    ];
    expect(planResume(transcript)).toEqual({
      kind: 'already-complete',
      messages: transcript.slice(0, -1),
    });
  });

  it('treats fully-answered trailing calls as a normal continuation point', () => {
    const transcript = [
      user('build a course'),
      // Results precede the assistant message (re-ordered before checkpoint).
      toolResult('c1'),
      assistantWithCalls([{ id: 'c1', name: 'list_scenes' }]),
    ];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('continue');
    if (plan.kind === 'continue') expect(plan.repairedToolCalls).toEqual([]);
  });

  it('falls back to the longest legal prefix on an unknown trailing role', () => {
    const weird = { role: 'custom', content: [] } as unknown as AgentMessage;
    const transcript = [user('a'), assistantText('b'), toolResult('c1'), weird];
    const plan = planResume(transcript);
    expect(plan.kind).toBe('continue');
    if (plan.kind === 'continue') {
      expect(plan.messages).toHaveLength(3);
      expect(plan.messages[plan.messages.length - 1].role).toBe('toolResult');
    }
  });
});
