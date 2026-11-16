import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import { currentTeachingContext } from '@/lib/server/pbl-v3/teaching-context';
import { preloadInitialPlan, withPlanToolContext } from '@/lib/server/pbl-v3/plan-tool-context';
import {
  withRequestSystemTail,
  requestSystemTail,
  appendRequestSystemTail,
} from '@/lib/agent/runtime/request-system-tail';

const text = 'Exact saved plan, including the learner choice and full details.\n'.repeat(80);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const plan = (s = text) => ({
  text: s,
  literalPrompt: 'RULES\nFILE: ' + s + '\nEND RULES',
  referencePrompt: 'RULES\nFILE: REFERENCE\nEND RULES',
});
const user: Message = { role: 'user', content: 'Please review this version.', timestamp: 1 };
const model = { api: 'openai-completions' as const, provider: 'test', id: 'test' };
function read(s = text, extra: Record<string, unknown> = {}): Message {
  return {
    role: 'toolResult',
    toolName: 'read_file',
    toolCallId: 'read-plan',
    isError: false,
    timestamp: 2,
    content: [
      { type: 'text', text: JSON.stringify({ path: 'PLAN.md', text: s, hash: hash(s), ...extra }) },
    ],
  };
}
function write(s = text): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'test',
    model: 'test',
    timestamp: 2,
    stopReason: 'toolUse',
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
        name: 'write_file',
        id: 'write-plan',
        arguments: { path: 'PLAN.md', text: s },
      },
    ],
  };
}
function saved(s = text, isError = false): Message {
  return {
    role: 'toolResult',
    toolName: 'write_file',
    toolCallId: 'write-plan',
    isError,
    timestamp: 3,
    content: [{ type: 'text', text: JSON.stringify({ written: true, hash: hash(s) }) }],
  };
}
function context(messages: Message[], s = text): Context {
  return withRequestSystemTail(
    { systemPrompt: plan(s).literalPrompt, messages },
    'FULL ACTIVE SECTION\nCURRENT QUESTION AND APPROVAL FACTS',
  );
}

describe('exact initial plan tool context', () => {
  it('retains the full file once, without altering instructions, history or learner evidence', () => {
    const c = context([user, read()]);
    const before = JSON.stringify(c);
    const p = withPlanToolContext(c, plan());
    expect(p.systemPrompt).toBe(plan().referencePrompt);
    expect(p.messages).toBe(c.messages);
    expect(requestSystemTail(p)).toContain(
      'FULL ACTIVE SECTION\nCURRENT QUESTION AND APPROVAL FACTS',
    );
    expect(requestSystemTail(p)).toContain('read-plan');
    expect(requestSystemTail(p)).not.toContain(text);
    expect(JSON.stringify(p.messages)).toContain('Exact saved plan');
    expect(JSON.stringify(c)).toBe(before);
    expect(requestSystemTail(withPlanToolContext(p, plan()))).toBe(requestSystemTail(p));
  });

  it('requires successful paired write arguments with the exact version and host hash', () => {
    const c = context([user, write(), saved()]);
    expect(withPlanToolContext(c, plan()).systemPrompt).toBe(plan().referencePrompt);
    for (const messages of [
      [user, saved()],
      [user, write()],
      [user, write(), saved(text, true)],
      [user, write('older'), saved()],
    ])
      expect(withPlanToolContext(context(messages), plan()).systemPrompt).toBe(
        plan().literalPrompt,
      );
  });

  it.each([
    read(text, { path: 'other.md' }),
    read(text, { hash: hash('older') }),
    read(text, { offset: 1 }),
    read(text, { nextOffset: 100 }),
    read('partial'),
    { ...read(), isError: true },
    { ...user, content: JSON.stringify({ path: 'PLAN.md', text, hash: hash(text) }) },
  ])(
    'keeps the complete snapshot for partial, stale, failed or learner-authored records: %#',
    (m) => {
      const c = context([user, m]);
      expect(withPlanToolContext(c, plan())).toBe(c);
    },
  );

  it('retains exact tiny files too, so the head does not switch as a plan grows', () => {
    const c = context([user, read('tiny')], 'tiny');
    expect(withPlanToolContext(c, plan('tiny')).systemPrompt).toBe(plan('tiny').referencePrompt);
    expect(withPlanToolContext(c)).toBe(c);
  });

  it('preloads the real initial read once, without adding learner speech or approval', () => {
    const c = context([user]);
    const messages = preloadInitialPlan(c, plan(), model);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'toolResult']);
    const projected = withPlanToolContext({ ...c, messages: [...c.messages, ...messages] }, plan());
    expect(projected.systemPrompt).toBe(plan().referencePrompt);
    const receipt = messages[1]!;
    expect(receipt.role).toBe('toolResult');
    if (receipt.role !== 'toolResult' || receipt.content[0]?.type !== 'text')
      throw new Error('Missing full-file receipt');
    expect(JSON.parse(receipt.content[0].text).text).toBe(text);
    expect(preloadInitialPlan(projected, plan(), model)).toEqual([]);
    expect(preloadInitialPlan(projected, plan(text + 'actual edit'), model)).toHaveLength(2);
    expect(preloadInitialPlan(c, undefined, model)).toEqual([]);
    expect(messages[0]).toMatchObject({ usage: { totalTokens: 0 }, stopReason: 'toolUse' });
  });

  it('repairs an interrupted preload without treating a partial record as coverage', () => {
    const c = context([user]);
    const [call, receipt] = preloadInitialPlan(c, plan(), model);
    const interrupted = { ...c, messages: [user, call!] };
    const repaired = preloadInitialPlan(interrupted, plan(), model);
    expect(repaired).toHaveLength(2);
    expect(preloadInitialPlan({ ...c, messages: [user, call!, receipt!] }, plan(), model)).toEqual(
      [],
    );
    expect(JSON.stringify(repaired)).not.toContain('approval');
  });

  it('keeps one stable head before the first model read and after a learner-edited version', () => {
    const first = context([user]);
    const initial = preloadInitialPlan(first, plan(), model);
    const a = withPlanToolContext({ ...first, messages: [...first.messages, ...initial] }, plan());
    const text2 = text + 'New learner request.';
    const second = context([...a.messages, { ...user, timestamp: 5 }], text2);
    const update = preloadInitialPlan(second, plan(text2), model);
    const b = withPlanToolContext(
      { ...second, messages: [...second.messages, ...update] },
      plan(text2),
    );
    expect(a.systemPrompt).toBe(b.systemPrompt);
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
    expect(requestSystemTail(b)).toContain(hash(text2));
  });

  it('restores the entire file after receipt removal, preserving summaries and recovery text', () => {
    const original = context([user, read()]);
    const projected = withPlanToolContext(original, plan());
    const recovery = appendRequestSystemTail(
      { ...projected, systemPrompt: projected.systemPrompt + '\nHOST SUMMARY' },
      'DELIVERED PROSE',
    );
    const restored = withPlanToolContext({ ...recovery, messages: [user] }, plan());
    expect(restored.systemPrompt).toBe(plan().literalPrompt + '\nHOST SUMMARY');
    expect(requestSystemTail(restored)).toBe(requestSystemTail(original) + '\nDELIVERED PROSE');
  });

  it('does not reference an earlier-stage result removed from current teaching history', () => {
    const c = context([user, read(), { ...user, timestamp: 4 }]);
    const projected = currentTeachingContext(c, {
      stageKey: 'next:2',
      studentTurns: 1,
      initialPlan: plan(),
    });
    expect(projected.systemPrompt?.endsWith(plan().literalPrompt)).toBe(true);
    expect(requestSystemTail(projected)).not.toContain('initialPlanSource');
  });

  it('keeps the reusable head stable across exact file-version changes with retained receipts', () => {
    const a = withPlanToolContext(context([user, write(), saved()]), plan());
    const next = text + 'Actual learner change.';
    const b = withPlanToolContext(context([user, write(next), saved(next)], next), plan(next));
    expect(a.systemPrompt).toBe(b.systemPrompt);
    expect(requestSystemTail(b)).toContain(hash(next));
    expect(JSON.stringify(b.messages)).toContain('Actual learner change.');
  });
});
