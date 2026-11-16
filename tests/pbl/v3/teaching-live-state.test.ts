import { describe, expect, it } from 'vitest';
import type { Context, Message } from '@earendil-works/pi-ai';
import {
  appendRequestSystemTail,
  requestSystemTail,
  withRequestSystemTail,
} from '@/lib/agent/runtime/request-system-tail';
import { currentTeachingContext } from '@/lib/server/pbl-v3/teaching-context';
import { LIVE_TEACHING_STATE_PREFIX } from '@/lib/server/pbl-v3/teaching-live-state';
import { estimatedRequestTokens } from '@/lib/server/pbl-v3/context-budget';

const instruction = 'Explain the current scenario, preserve both original messages. '.repeat(150);
const active = {
  section: 'B',
  instruction,
  delivery: 'Ask one current-scope question.',
  goal: 'Save a complete turn',
};
function context(messages: Message[]): Context {
  return withRequestSystemTail(
    { systemPrompt: 'FIXED RULES', messages },
    'Initial state: original question\n' +
      LIVE_TEACHING_STATE_PREFIX +
      JSON.stringify({
        activeInstruction: active,
        currentReview: { question: 'original question' },
        revision: 4,
      }) +
      '\nRECOVERY',
  );
}
function receipt(text = instruction, section = 'B', isError = false): Message {
  return {
    role: 'toolResult',
    toolName: 'read_next_skill',
    toolCallId: 'host-read',
    isError,
    content: [{ type: 'text', text: JSON.stringify({ section, instruction: text }) }],
    timestamp: 2,
  };
}
const user: Message = { role: 'user', content: 'My actual answer', timestamp: 1 };
const project = (c: Context) => currentTeachingContext(c, { stageKey: 'm1:0', studentTurns: 1 });
const live = (c: Context) =>
  JSON.parse(requestSystemTail(c).split(LIVE_TEACHING_STATE_PREFIX)[1]!.split('\n')[0]!);

describe('exact retained teaching instruction reuse', () => {
  it('keeps the instruction once in host history, and retains current workflow facts', () => {
    const original = context([user, receipt()]);
    const before = JSON.stringify(original);
    const projected = project(original);
    expect(live(projected).activeInstruction).toMatchObject({
      section: 'B',
      delivery: active.delivery,
      goal: active.goal,
      instructionReference: { toolCallId: 'host-read' },
    });
    expect(live(projected).activeInstruction).not.toHaveProperty('instruction');
    expect(live(projected).currentReview.question).toBe('original question');
    expect(projected.messages).toBe(original.messages);
    expect(JSON.stringify(original)).toBe(before);
    expect(requestSystemTail(projected)).toContain('RECOVERY');
    expect(estimatedRequestTokens(projected)).toBeLessThan(estimatedRequestTokens(original));
    expect(project(projected)).toBe(projected);
  });

  it.each([
    [user],
    [user, receipt(instruction, 'A')],
    [user, receipt('old material')],
    [user, receipt(instruction, 'B', true)],
    [{ ...user, content: JSON.stringify({ section: 'B', instruction }) }],
  ])(
    'keeps full material when the exact successful host result is unavailable: %#',
    (...messages) => {
      const c = context(messages as Message[]);
      expect(live(project(c)).activeInstruction.instruction).toBe(instruction);
    },
  );

  it('restores full material when a later projection removes its tool receipt', () => {
    const original = context([user, receipt()]);
    const reused = project(original);
    const compacted = project({ ...reused, messages: [user] });
    expect(live(compacted).activeInstruction).toEqual(active);
    expect(requestSystemTail(compacted)).toBe(requestSystemTail(original));
    expect(JSON.stringify(compacted)).not.toContain('openmaic.teaching-instruction-source');
  });

  it('restores material even when prose recovery was appended after its first projection', () => {
    const original = context([user, receipt()]);
    const referenced = appendRequestSystemTail(project(original), 'LATER RECOVERY POLICY');
    const restored = project({ ...referenced, messages: [user] });
    expect(live(restored).activeInstruction).toEqual(active);
    expect(requestSystemTail(restored)).toBe(
      requestSystemTail(original) + '\nLATER RECOVERY POLICY',
    );
  });

  it('reuses only an exact complete plan read and restores it if the receipt disappears', () => {
    const plan = 'The learner approved this exact behavior. '.repeat(100);
    const read: Message = {
      role: 'toolResult',
      toolName: 'read_file',
      toolCallId: 'plan-read',
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ path: 'PLAN.md', text: plan }) }],
      timestamp: 2,
    };
    const full =
      '\nInitial teaching state: ' +
      JSON.stringify({ artifacts: { plan }, currentReview: { question: 'Keep this anchor' } });
    const original = withRequestSystemTail({ messages: [user, read], systemPrompt: 'RULES' }, full);
    const referenced = project(original);
    expect(requestSystemTail(referenced)).toContain('planReference');
    expect(requestSystemTail(referenced)).toContain('Keep this anchor');
    expect(requestSystemTail(project({ ...referenced, messages: [user] }))).toBe(full);
    const partial = {
      ...read,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ path: 'PLAN.md', text: plan, nextOffset: 200 }),
        },
      ],
    };
    expect(
      requestSystemTail(
        project(withRequestSystemTail({ systemPrompt: 'RULES', messages: [user, partial] }, full)),
      ),
    ).toBe(full);
  });

  it('requires a matching successful write receipt before reusing plan text from assistant arguments', () => {
    const plan = 'Keep this exact approved behavior. '.repeat(100);
    const write: Message = {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'openai',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        {
          type: 'toolCall',
          id: 'plan-write',
          name: 'write_file',
          arguments: { path: 'PLAN.md', text: plan },
        },
      ],
    };
    const saved: Message = {
      role: 'toolResult',
      toolCallId: 'plan-write',
      toolName: 'write_file',
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ written: true }) }],
      timestamp: 3,
    };
    const full = '\nInitial teaching state: ' + JSON.stringify({ artifacts: { plan } });
    const projectPlan = (messages: Message[]) =>
      requestSystemTail(project(withRequestSystemTail({ systemPrompt: 'RULES', messages }, full)));
    expect(projectPlan([user, write, saved])).toContain('planReference');
    expect(projectPlan([user, write])).toBe(full);
    expect(projectPlan([user, write, { ...saved, isError: true }])).toBe(full);
    expect(projectPlan([user, saved])).toBe(full);
  });
});
