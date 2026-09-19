/**
 * Instructor — silent difficulty change must still leave a visible reply.
 *
 * Product design: a proficiency/difficulty change is UNDERLYING — its tier
 * (beginner/intermediate/advanced) is NEVER surfaced to the learner. So the
 * reviewer's "render a difficulty status chip" suggestion is intentionally NOT
 * implemented.
 *
 * BUT the underlying gap the reviewer flagged is real: when the model handles a
 * learner's "make it easier / I'm a beginner" request by calling ONLY
 * `adjust_difficulty` and writes no acknowledgment text, the turn used to leave
 * the learner with NOTHING — the tier change is silent (no chat patch) and
 * `shouldReportEmptyOutput` suppresses the empty-output error once any tool ran.
 *
 * Fix under test: a turn that ran `adjust_difficulty` with no text commits a
 * neutral, localized, TIER-AGNOSTIC confirmation so the learner sees a reply —
 * without ever naming the difficulty level. Other silent tools
 * (record_observation) do NOT trigger this fallback:
 * they are internal bookkeeping, not a learner request, and must stay silent.
 */
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

import { runInstructorTurn } from '@/lib/pbl/v2/agents/instructor';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';

type DoStreamConfig = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doStream']
>;
type StreamResult = Extract<DoStreamConfig, { stream: unknown }>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const FINISH_STOP = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: USAGE,
};
const FINISH_TOOLS = {
  type: 'finish' as const,
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
  usage: USAGE,
};

function toolCallStep(toolName: string, input: Record<string, unknown>): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: `tc-${toolName}`, toolName, input: JSON.stringify(input) },
    FINISH_TOOLS,
  ];
}

function textStep(toolName: string, input: Record<string, unknown>, text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: `tc-${toolName}`, toolName, input: JSON.stringify(input) },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    FINISH_STOP,
  ];
}

function scriptedModel(steps: StreamPart[][]): MockLanguageModelV3 {
  let i = 0;
  const fallback: StreamPart[] = [{ type: 'stream-start', warnings: [] }, FINISH_STOP];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream(steps[i++] ?? fallback) }),
  });
}

function makeProject(language = 'zh-CN'): PBLProjectV2 {
  const now = '2026-06-10T00:00:00.000Z';
  return {
    uiPhase: 'workspace',
    title: 'Build a HashMap Playground',
    description: 'A small interactive HashMap tool for a beginner.',
    learningObjective: 'Learn HashMap operations by building a toy tool.',
    proficiency: 'intermediate',
    language,
    tags: ['hashmap'],
    status: 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'ms-1',
        title: 'Model the core HashMap behavior',
        order: 0,
        status: 'active',
        microtasks: [
          {
            id: 'mt-1',
            title: 'Implement lookup',
            description: 'Use a key to find the right bucket and return the value.',
            status: 'in_progress',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
        documents: [],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function runTurn(
  model: MockLanguageModelV3,
  userMessage: string,
  language = 'zh-CN',
): Promise<PBLSSEEvent[]> {
  const events: PBLSSEEvent[] = [];
  for await (const ev of runInstructorTurn({
    project: makeProject(language),
    userMessage,
    phase: 'instructing',
    languageModel: model as never,
  })) {
    events.push(ev);
  }
  return events;
}

function committedMessages(events: PBLSSEEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<PBLSSEEvent, { type: 'project_patch' }> =>
        e.type === 'project_patch' && e.patch.kind === 'message',
    )
    .map((e) => (e.patch as { message: { content: string } }).message.content);
}

function hasEmptyOutputError(events: PBLSSEEvent[]): boolean {
  return events.some(
    (e) => e.type === 'error' && (e as { code?: string }).code === 'EMPTY_LLM_OUTPUT',
  );
}

// Tier words that must NEVER appear in the user-facing confirmation, in every
// supported language.
const TIER_WORDS = [
  'beginner',
  'intermediate',
  'advanced',
  '初级',
  '中级',
  '高级',
  '初級',
  '中級',
  '高級',
  '初心者',
  '中級者',
  '上級',
  'нач'.slice(0, 3), // ru "начинающий"
  'iniciante',
  'مبتدئ',
];

function assertTierAgnostic(text: string): void {
  for (const w of TIER_WORDS) {
    expect(text.toLowerCase().includes(w.toLowerCase())).toBe(false);
  }
}

describe('Instructor — adjust_difficulty leaves a visible, tier-agnostic reply when the model writes no text', () => {
  it('commits a neutral confirmation on a NO-OP difficulty change (target == current) with no model text', async () => {
    // intermediate learner asks to set intermediate → applyProficiencyDirective
    // returns { patches: [] } (no proficiency patch at all). The model writes no
    // acknowledgment. Without the fix the learner sees absolutely nothing.
    const events = await runTurn(
      scriptedModel([toolCallStep('adjust_difficulty', { target: 'intermediate' })]),
      '保持中等难度就好',
    );

    const committed = committedMessages(events);
    expect(committed).toHaveLength(1);
    expect(committed[0].trim().length).toBeGreaterThan(0);
    assertTierAgnostic(committed[0]);
    expect(hasEmptyOutputError(events)).toBe(false);
  });

  it('commits a neutral confirmation on a REAL difficulty change with no model text', async () => {
    const events = await runTurn(
      scriptedModel([toolCallStep('adjust_difficulty', { target: 'easier' })]),
      '太难了，简单一点',
    );

    const committed = committedMessages(events);
    expect(committed).toHaveLength(1);
    assertTierAgnostic(committed[0]);
    expect(hasEmptyOutputError(events)).toBe(false);
  });

  it('localizes the confirmation (en-US is not the zh-CN string)', async () => {
    const zh = committedMessages(
      await runTurn(
        scriptedModel([toolCallStep('adjust_difficulty', { target: 'easier' })]),
        'easier',
        'zh-CN',
      ),
    )[0];
    const en = committedMessages(
      await runTurn(
        scriptedModel([toolCallStep('adjust_difficulty', { target: 'easier' })]),
        'easier',
        'en-US',
      ),
    )[0];
    expect(zh).not.toEqual(en);
    assertTierAgnostic(zh);
    assertTierAgnostic(en);
  });

  it('does NOT add a fallback when the model DID write its own acknowledgment (happy path untouched)', async () => {
    const MODEL_TEXT = '好的，我们把节奏放慢一点，换个更直观的角度来讲。';
    const events = await runTurn(
      scriptedModel([textStep('adjust_difficulty', { target: 'easier' }, MODEL_TEXT)]),
      '太难了',
    );
    const committed = committedMessages(events);
    expect(committed).toEqual([MODEL_TEXT]);
  });

  it('does NOT commit the difficulty ACK for record_observation-only turns (the ack is scoped to adjust_difficulty)', async () => {
    // record_observation is internal bookkeeping, NOT a learner difficulty
    // request — so it must never trigger the neutral difficulty confirmation.
    // It also produces no user-perceivable output on its own, so the
    // empty-output retry fallback is the correct outcome (#593 point 1) — the
    // learner must not get silence.
    const events = await runTurn(
      scriptedModel([
        toolCallStep('record_observation', {
          kind: 'question',
          signature: 'lookup_ok',
          label: 'lookup',
        }),
      ]),
      '我写完 lookup 了',
    );
    // No neutral difficulty confirmation was committed.
    expect(committedMessages(events)).toHaveLength(0);
    // The turn produced nothing user-perceivable → retry fallback fires.
    expect(hasEmptyOutputError(events)).toBe(true);
  });
});
