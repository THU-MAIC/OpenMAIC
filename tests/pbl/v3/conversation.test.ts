import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  projectConversation,
  learningRunFailure,
  boundConversation,
} from '@/lib/server/pbl-v3/conversation';
import { mergeConversationHistory } from '@/lib/pbl/v3/conversation';
import { stageSkill, interactionRules } from '@/lib/server/pbl-v3/skills';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { renderTeachingPrompt, teachingSection } from '@/lib/server/pbl-v3/teaching-prompt';
import { isFinalProjectRecap } from '@/lib/server/pbl-v3/stage-progress';
import {
  startOrchestration,
  allowedStudentActions,
} from '@/lib/pbl/v3/domain/orchestration/transition';
import type { PersistedAgentSessionEvent } from '@openmaic/storage';
import type { StageDefinition } from '@/lib/pbl/v3/domain/project/project-schema';
import { createThinkingTimingTracker } from '@/lib/server/pbl-v3/thinking-timing';

const event = (
  id: number,
  type: string,
  data: unknown,
  attempt = type === 'user_message' || type === 'pbl_stage_entered' ? 0 : 1,
): PersistedAgentSessionEvent => ({ id, type, data, attempt, ts: id });
const message = (text: string) => ({
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
  },
});
describe('student conversation projection', () => {
  it.each([false, true])(
    'keeps original reply identity across crash recovery (SDK receipt: %s)',
    (sdk) => {
      const response = 'Use Project files in the IDE.';
      const before = [
        event(1, 'user_message', { text: 'Where are my files?' }),
        event(2, 'message_start', message('')),
        event(3, 'message_end', message(response)),
      ];
      const original = projectConversation(before, 'discussion', false)
        .flatMap((e) => e.parts)
        .find((p) => p.kind === 'text' && p.text === response)!;
      const entries = projectConversation(
        [
          ...before,
          event(4, 'session_resumed', {}, 2),
          event(
            5,
            'pbl_learner_handoff',
            { question: response, kind: 'support', toolCallId: 'recovered' },
            2,
          ),
          ...(sdk
            ? [
                event(
                  6,
                  'tool_execution_end',
                  {
                    toolName: 'respond_to_learner',
                    toolCallId: 'recovered',
                    result: { content: [{ type: 'text', text: JSON.stringify({ response }) }] },
                  },
                  2,
                ),
              ]
            : []),
          event(7, 'session_end', { status: 'succeeded' }, 2),
        ],
        'discussion',
        false,
      );
      const replies = entries
        .flatMap((e) => e.parts)
        .filter((p) => p.kind === 'text' && p.text === response);
      expect(replies).toEqual([original]);
      if (sdk)
        expect(entries.flatMap((e) => e.parts)).toContainEqual(
          expect.objectContaining({
            kind: 'tool',
            name: 'respond_to_learner',
            status: 'succeeded',
          }),
        );
    },
  );

  it('deduplicates recovered handoffs when older history pages arrive without losing a later identical reply', () => {
    const response = 'Use Project files in the IDE.';
    const older = projectConversation(
      [event(2, 'message_end', { ...message(response), pblMessageId: 2, pblInputId: 1 })],
      'discussion',
      false,
      undefined,
      true,
    );
    const newer = projectConversation(
      [
        event(
          5,
          'pbl_learner_handoff',
          { question: response, toolCallId: 'recovered', pblInputId: 1 },
          2,
        ),
        event(6, 'session_end', { status: 'succeeded', pblInputId: 1 }, 2),
        event(7, 'user_message', { text: 'Please remind me.' }),
        event(
          8,
          'pbl_learner_handoff',
          { question: response, toolCallId: 'new-answer', pblInputId: 7 },
          3,
        ),
      ],
      'discussion',
      false,
      undefined,
      true,
    );
    const pages = [older, newer];
    const saved = structuredClone(pages);
    const parts = mergeConversationHistory(pages)
      .flatMap((e) => e.parts)
      .filter((p) => p.kind === 'text' && p.text === response);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.id).toBe(older[0]!.parts[0]!.id);
    expect(pages).toEqual(saved);
  });

  it('deduplicates a multi-block answer across attempts without suppressing independent model replies', () => {
    const content = [
      { type: 'text', text: 'First explanation.' },
      { type: 'text', text: 'Second explanation.' },
    ];
    const entries = projectConversation(
      [
        event(1, 'user_message', { text: 'Help me navigate.' }),
        event(2, 'message_end', { message: { role: 'assistant', content } }),
        event(
          3,
          'pbl_learner_handoff',
          { question: 'First explanation.\nSecond explanation.', toolCallId: 'recovery' },
          2,
        ),
        event(4, 'message_end', message('A genuine later model reply.'), 2),
        event(5, 'message_end', message('A genuine later model reply.'), 2),
      ],
      'discussion',
      false,
    );
    expect(
      entries
        .flatMap((e) => e.parts)
        .filter((p) => p.kind === 'text')
        .map((p) => p.text),
    ).toEqual([
      'Help me navigate.',
      'First explanation.',
      'Second explanation.',
      'A genuine later model reply.',
      'A genuine later model reply.',
    ]);
  });

  it('deduplicates a committed handoff and its SDK receipt by call identity across learner turns', () => {
    const question = 'Which build requirement should we clarify?';
    const receipt = {
      toolName: 'request_learner_help',
      toolCallId: 'help-1',
      isError: false,
      result: { content: [{ type: 'text', text: JSON.stringify({ question }) }] },
    };
    const entries = projectConversation(
      [
        event(1, 'pbl_learner_handoff', { question, toolCallId: 'help-1' }),
        event(2, 'tool_execution_end', receipt),
        event(3, 'user_message', { text: 'Please explain.' }),
        event(4, 'pbl_learner_handoff', { question, toolCallId: 'help-2' }),
        event(5, 'tool_execution_end', { ...receipt, toolCallId: 'help-2' }),
      ],
      'discussion',
      false,
    );
    expect(
      entries
        .flatMap((entry) => entry.parts)
        .filter((part) => part.kind === 'text' && part.text === question),
    ).toHaveLength(2);
  });

  it('keeps the question after model prose even if the transactional event wins the append race', () => {
    const question = 'What should we clarify?';
    const entries = projectConversation(
      [
        event(1, 'pbl_learner_handoff', { question, toolCallId: 'help-1' }),
        event(2, 'message_end', message('Here is the build problem.')),
        event(3, 'tool_execution_end', {
          toolName: 'request_learner_help',
          toolCallId: 'help-1',
          isError: false,
          result: { content: [{ type: 'text', text: JSON.stringify({ question }) }] },
        }),
      ],
      'discussion',
      false,
    );
    expect(
      entries
        .flatMap((entry) => entry.parts)
        .filter((part) => part.kind === 'text')
        .map((part) => part.text),
    ).toEqual(['Here is the build problem.', question]);
  });

  it('keeps the latest large model message whole when a host handoff follows it', () => {
    const text = 'Long teaching explanation. '.repeat(30000);
    const question = 'What should we clarify?';
    const entries = projectConversation(
      [
        event(1, 'message_end', message(text)),
        event(2, 'pbl_learner_handoff', { question, toolCallId: 'help-1' }),
        event(3, 'tool_execution_end', {
          toolName: 'request_learner_help',
          toolCallId: 'help-1',
          isError: false,
          result: { content: [{ type: 'text', text: JSON.stringify({ question }) }] },
        }),
      ],
      'discussion',
      false,
    );
    const parts = entries.flatMap((entry) => entry.parts);
    expect(parts.some((part) => part.kind === 'text' && part.text === text)).toBe(true);
    expect(parts.filter((part) => part.kind === 'text' && part.text === question)).toHaveLength(1);
  });

  it('keeps thinking identity and duration when only the latest snapshot survives compaction', () => {
    const track = createThinkingTimingTracker();
    const frame = (thinking: string, text = '') => ({
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking }, ...(text ? [{ type: 'text', text }] : [])],
      },
    });
    const start = event(2, 'message_start', track('message_start', frame(''), 2));
    const first = event(10, 'message_update', track('message_update', frame('Considering'), 10));
    const original = projectConversation([start, first], 'discussion', true)[0]!.parts[0]!;
    const updated = event(
      20,
      'message_update',
      track('message_update', frame('Considering more'), 20),
    );
    const live = projectConversation([start, updated], 'discussion', true)[0]!.parts[0]!;
    expect(live).toMatchObject({ id: original.id, startedAt: 10, streaming: true });
    track('message_update', frame('Considering more', 'Answer'), 30);
    const end = event(
      50,
      'message_end',
      track('message_end', frame('Considering more', 'Answer'), 50),
    );
    const replay = projectConversation([start, end], 'discussion', false)[0]!.parts[0]!;
    expect(replay).toMatchObject({ id: original.id, startedAt: 10, endedAt: 30, streaming: false });
  });

  it('tracks separate thinking blocks and resets anchors for the next message', () => {
    const track = createThinkingTimingTracker();
    const frame = (...content: unknown[]) => ({ message: { role: 'assistant', content } });
    track('message_start', frame(), 1);
    track('message_update', frame({ type: 'thinking', thinking: 'First' }), 5);
    track(
      'message_update',
      frame({ type: 'thinking', thinking: 'First' }, { type: 'text', text: 'A' }),
      9,
    );
    const second = frame(
      { type: 'thinking', thinking: 'First' },
      { type: 'text', text: 'A' },
      { type: 'thinking', thinking: 'Second' },
    );
    track('message_update', second, 20);
    expect(track('message_end', second, 25)).toMatchObject({
      pblThinkingTimings: { 0: { startedAt: 5, endedAt: 9 }, 2: { startedAt: 20, endedAt: 25 } },
    });
    track('message_start', frame(), 40);
    expect(track('message_end', frame({ type: 'thinking', thinking: 'New' }), 50)).toMatchObject({
      pblThinkingTimings: { 0: { startedAt: 50, endedAt: 50 } },
    });
  });

  it.each([true, false])(
    'shows one question body while retaining the full review card (already spoken: %s)',
    (spoken) => {
      const question = 'What does the caller receive?';
      const result = {
        content: [{ type: 'text', text: JSON.stringify({ question, waitForStudent: true }) }],
      };
      const entries = projectConversation(
        [
          event(1, 'session_start', {}),
          event(
            2,
            'message_end',
            message('The goal is to add a task.' + (spoken ? ` ${question}` : '')),
          ),
          event(3, 'tool_execution_start', {
            toolName: 'request_skill_review',
            toolCallId: 'review',
            args: { question },
          }),
          event(4, 'tool_execution_end', {
            toolName: 'request_skill_review',
            toolCallId: 'review',
            isError: false,
            result,
          }),
        ],
        'discussion',
        false,
      );
      const parts = entries.flatMap((entry) => entry.parts);
      expect(
        parts.filter((part) => part.kind === 'text' && part.text.includes(question)),
      ).toHaveLength(1);
      expect(parts.find((part) => part.kind === 'tool')).toMatchObject({
        args: { question },
        result,
        status: 'succeeded',
      });
    },
  );
  it('keeps the latest reply and thinking complete beyond the history byte budget', () => {
    const text = 'Detailed explanation. '.repeat(60_000);
    const thinking = 'Thinking. '.repeat(60_000);
    const output = projectConversation(
      [
        event(1, 'user_message', { text: 'Please explain' }),
        event(2, 'message_end', {
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking },
              { type: 'text', text },
            ],
          },
        }),
      ],
      'discussion',
      false,
    );
    const parts = output.at(-1)!.parts;
    expect(parts.find((p) => p.kind === 'text')).toMatchObject({ text });
    expect(parts.find((p) => p.kind === 'thinking')).toMatchObject({ text: thinking });
    expect(output.at(-1)!.omitted).not.toBe(true);
  });
  it('bounds aggregate tool payloads in one turn while preserving the latest normal payload whole', () => {
    const events: PersistedAgentSessionEvent[] = [];
    const text = 'tool output '.repeat(4000);
    for (let i = 0; i < 100; i++)
      events.push(
        event(i + 1, 'tool_execution_end', {
          toolName: 'read_file',
          toolCallId: `call-${i}`,
          isError: false,
          result: { content: [{ type: 'text', text }], details: { index: i } },
        }),
      );
    const output = projectConversation(events, 'coder', false);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(600000);
    expect(output.some((e) => e.omitted)).toBe(true);
    expect(output[0]!.parts.at(-1)).toMatchObject({
      kind: 'tool',
      status: 'succeeded',
      result: { content: [{ type: 'text', text }], details: { index: 99 } },
    });
    expect(events[0].data).toHaveProperty('result.content.0.text', text);
  });
  it('keeps full long, nested payloads, progress and display for every emitted tool', () => {
    const text = 'full-output\n'.repeat(7000);
    const output = projectConversation(
      [
        event(1, 'tool_execution_start', {
          toolName: 'new_course_tool',
          toolCallId: 'x',
          args: { count: 7, options: { enabled: true }, items: [1, 2], text },
        }),
        event(2, 'tool_execution_update', {
          toolName: 'new_course_tool',
          toolCallId: 'x',
          partialResult: { content: [{ type: 'text', text: 'Halfway' }], details: { percent: 50 } },
        }),
        event(3, 'tool_execution_end', {
          toolName: 'new_course_tool',
          toolCallId: 'x',
          isError: true,
          result: { content: [{ type: 'text', text }], details: { display: 'Full display' } },
        }),
        event(4, 'session_end', { status: 'succeeded' }),
      ],
      'coder',
      false,
    );
    const part = output[0]!.parts[0]!;
    expect(part).toMatchObject({
      action: 'tool',
      name: 'new_course_tool',
      status: 'failed',
      args: { count: 7, options: { enabled: true }, items: [1, 2], text },
      progress: { kind: 'custom', data: { details: { percent: 50 } } },
      result: { content: [{ type: 'text', text }] },
      display: { display: 'Full display' },
    });
    expect(
      projectConversation(
        [
          event(1, 'tool_execution_update', {
            toolName: 'run_build',
            toolCallId: 'build',
            progress: { kind: 'compile', text: 'Compiling', percent: 50, data: { files: 3 } },
          }),
        ],
        'coder',
        true,
      )[0]!.parts[0],
    ).toMatchObject({ progress: { text: 'Compiling', percent: 50, data: { files: 3 } } });
  });
  it('distinguishes an unclosed review from model or provider failures', () => {
    expect(
      learningRunFailure(
        'Teaching turn ended without recording a review question or stage completion. Retry to continue the current review.',
      ),
    ).toBe('incomplete');
    expect(learningRunFailure('request timed out')).toBe('timeout');
    expect(learningRunFailure('401 unauthorized')).toBe('authentication');
  });
  it('keeps queued student messages and successful worker replies in one turn across exchanges', () => {
    const history: PersistedAgentSessionEvent[] = [];
    for (let round = 0; round < 3; round++) {
      const id = round * 4 + 1;
      history.push(event(id, 'user_message', { text: `Question ${round}`, delivery: 'queued' }));
      const waiting = projectConversation(history, 'discussion', true, 'queued');
      expect(waiting.at(-1)).toMatchObject({ id: `turn-${id}`, status: 'running', parts: [] });
      history.push(event(id + 1, round ? 'session_resumed' : 'session_start', {}));
      const started = projectConversation(history, 'discussion', true, 'running');
      expect(started).toEqual(waiting);
      history.push(
        event(id + 2, 'message_end', message(`Answer ${round}`)),
        event(id + 3, 'session_end', { status: 'succeeded' }),
      );
      const replay = projectConversation(history, 'discussion', false, 'succeeded');
      expect(replay).toHaveLength((round + 1) * 2);
      expect(
        replay.filter((entry) => entry.speaker === 'discussion').map((entry) => entry.status),
      ).toEqual(Array(round + 1).fill('succeeded'));
      expect(replay.at(-1)).toMatchObject({
        id: `turn-${id}`,
        parts: [{ text: `Answer ${round}` }],
      });
    }
  });
  it('does not interpret control-event generations as interrupted worker attempts', () => {
    const history = [
      event(1, 'user_message', { text: 'Start', pblOpening: true }, 3),
      event(2, 'session_resumed', {}, 4),
      event(3, 'message_start', message('Answer'), 4),
      event(4, 'material_extraction', { status: 'succeeded' }, 0),
      event(5, 'message_end', message('Answer complete'), 4),
      event(6, 'session_end', { status: 'succeeded' }, 4),
    ];
    const output = projectConversation(history, 'discussion', false);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ status: 'succeeded', parts: [{ text: 'Answer complete' }] });
  });
  it('preserves a real interrupted attempt and starts the next student reply without a phantom failure', () => {
    const history = [
      event(1, 'user_message', { text: 'Help' }),
      event(2, 'session_start', {}),
      event(3, 'message_update', message('Partial')),
      event(4, 'session_resumed', {}, 2),
      event(5, 'message_end', message('Recovered'), 2),
      event(6, 'session_end', { status: 'succeeded' }, 2),
      event(7, 'user_message', { text: 'Continue' }),
      event(8, 'session_resumed', {}),
      event(9, 'session_end', { status: 'failed' }),
    ];
    const output = projectConversation(history, 'discussion', false, 'failed');
    expect(output.map((entry) => entry.status)).toEqual([
      undefined,
      'interrupted',
      'succeeded',
      undefined,
    ]);
    expect(output[1]?.parts[0]).toMatchObject({ text: 'Partial', streaming: false });
  });
  it('does not fabricate an empty failed reply and still shows a queued retry waiting', () => {
    const history = [
      event(1, 'pbl_stage_entered', { milestoneId: 'one' }),
      event(2, 'user_message', { text: 'System opening', pblOpening: true }),
      event(3, 'session_end', { status: 'failed', error: 'Provider unavailable' }),
    ];
    const failed = projectConversation(history, 'discussion', false, 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].boundary).toBeDefined();
    const retrying = projectConversation(history, 'discussion', true, 'queued');
    expect(retrying.at(-1)).toMatchObject({ status: 'running', parts: [] });
  });
  it('distinguishes a recovered tool gate from a stalled model turn without leaking diagnostics', () => {
    const recovered = projectConversation(
      [
        event(1, 'session_start', {}),
        event(2, 'tool_execution_end', {
          toolName: 'complete_stage',
          toolCallId: 'gate',
          isError: true,
        }),
        event(3, 'message_end', message('We still need to review the plan.')),
        event(4, 'session_end', { status: 'succeeded' }),
      ],
      'planner',
      false,
    );
    expect(recovered[0]).toMatchObject({
      status: 'succeeded',
      parts: [{ status: 'failed' }, { text: 'We still need to review the plan.' }],
    });
    expect(recovered[0].failure).toBeUndefined();
    const failed = projectConversation(
      [
        event(1, 'session_start', {}),
        event(2, 'message_end', message('Partial reply')),
        event(3, 'session_end', {
          status: 'failed',
          error:
            'Teaching turn timed out after 120 seconds without progress (model). private-provider-diagnostic',
        }),
      ],
      'planner',
      false,
      'failed',
    );
    expect(failed[0]).toMatchObject({
      status: 'failed',
      failure: 'timeout',
      parts: [{ text: 'Partial reply', streaming: false }],
    });
    expect(JSON.stringify(failed)).not.toContain('private-provider');
  });
  it('replays durable stage dividers and hides system opening requests', () => {
    const boundary = {
      milestoneId: 'one',
      milestoneTitle: 'First outcome',
      milestoneIndex: 0,
      stageIndex: 0,
      step: 'teaching',
      total: 7,
    };
    const output = projectConversation(
      [
        event(1, 'pbl_stage_entered', boundary),
        event(2, 'user_message', { text: 'System stage entry', pblOpening: true }),
        event(3, 'message_end', message('Welcome to your project')),
        event(4, 'user_message', { text: 'My first answer' }),
      ],
      'discussion',
      false,
    );
    expect(output).toHaveLength(3);
    expect(output[0]?.boundary).toEqual(boundary);
    expect(output[1]?.speaker).toBe('discussion');
    expect(output[2]?.speaker).toBe('user');
    expect(JSON.stringify(output)).not.toContain('System stage entry');
  });
  it('updates a single text block and preserves full tool output in order', () => {
    const history = [
      event(1, 'user_message', { text: 'Please explain' }),
      event(2, 'message_start', message('')),
      event(3, 'message_update', message('Hel')),
      event(4, 'message_update', message('Hello')),
      event(5, 'message_end', message('Hello')),
      event(6, 'tool_execution_start', {
        toolName: 'write_file',
        toolCallId: 'w',
        args: { text: 'print(1)' },
      }),
      event(7, 'tool_execution_end', {
        toolName: 'write_file',
        toolCallId: 'w',
        result: { content: [{ type: 'text', text: 'PRIVATE OUTPUT' }] },
      }),
      event(8, 'tool_execution_start', { toolName: 'read_next_skill', toolCallId: 's' }),
      event(9, 'tool_execution_end', {
        toolName: 'read_next_skill',
        toolCallId: 's',
        result: { content: [{ type: 'text', text: 'SECRET PROTOCOL' }] },
      }),
      event(10, 'message_start', message('Done')),
      event(11, 'message_update', message('Done, now review')),
    ];
    const output = projectConversation(history, 'coder', true);
    expect(output).toHaveLength(2);
    expect(output[1]!.parts.map((p) => p.kind)).toEqual(['text', 'tool', 'tool', 'text']);
    expect(output[1]!.parts[0]).toMatchObject({ text: 'Hello', streaming: false });
    expect(output[1]!.parts[3]).toMatchObject({ text: 'Done, now review', streaming: true });
    expect(JSON.stringify(output)).toContain('PRIVATE OUTPUT');
    expect(JSON.stringify(output)).toContain('SECRET PROTOCOL');
  });
  it('preserves full thinking snapshots and duration in live and replay output', () => {
    const frame = (thinking: string, text = '') => ({
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking }, ...(text ? [{ type: 'text', text }] : [])],
      },
    });
    const history = [
      event(1, 'session_start', {}),
      event(2, 'message_start', frame('')),
      event(3, 'message_update', frame('Consider the input.')),
    ];
    const first = projectConversation(history, 'discussion', true);
    expect(first[0]?.parts).toEqual([
      {
        kind: 'thinking',
        id: 'thinking-2-0',
        messageId: 2,
        text: 'Consider the input.',
        startedAt: 3,
        streaming: true,
      },
    ]);
    history.push(event(7, 'message_update', frame('Consider the input and output.', 'Explain')));
    history.push(event(8, 'thinking_end', {}));
    history.push(event(9, 'message_end', frame('Consider the input and output.', 'Explanation')));
    history.push(event(10, 'session_end', { status: 'succeeded' }));
    const replay = projectConversation(history, 'discussion', false);
    expect(replay[0]?.status).toBe('succeeded');
    expect(replay[0]?.parts.map((p) => p.kind)).toEqual(['thinking', 'text']);
    expect(replay[0]?.parts[0]).toMatchObject({ endedAt: 7, streaming: false });
    expect(replay[0]?.parts[1]).toMatchObject({ text: 'Explanation', streaming: false });
    expect(projectConversation(history, 'discussion', true)).toEqual(replay);
    expect(replay[0]?.parts[0]).toMatchObject({ text: 'Consider the input and output.' });
    expect(JSON.stringify(first)).toContain('Consider the input.');
  });
  it('shows one pre-content wait and separates cancellation/retry without animating history', () => {
    const history = [event(1, 'user_message', { text: 'Explain' }), event(2, 'session_start', {})];
    expect(projectConversation(history, 'mentor', true)[1]).toMatchObject({
      status: 'running',
      parts: [],
    });
    history.push(event(3, 'session_end', { status: 'cancelled', error: 'SECRET' }));
    const queued = projectConversation(history, 'mentor', true, 'queued');
    expect(queued.map((p) => p.status)).toEqual([undefined, 'cancelled', 'running']);
    history.push(
      event(4, 'session_start', {}, 2),
      event(5, 'message_end', message('Retry reply'), 2),
      event(6, 'session_end', { status: 'succeeded' }, 2),
    );
    const replay = projectConversation(history, 'mentor', false);
    expect(replay.map((p) => p.status)).toEqual([undefined, 'cancelled', 'succeeded']);
    expect(JSON.stringify(replay)).not.toContain('SECRET');
  });
  it('preserves full structured tool inputs, outputs and skill content', () => {
    const result = (value: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify(value) }],
    });
    const output = projectConversation(
      [
        event(1, 'tool_execution_start', {
          toolName: 'read_file',
          toolCallId: 'r',
          args: { path: 'src/main.py', token: 'SECRET' },
        }),
        event(2, 'tool_execution_end', {
          toolName: 'read_file',
          toolCallId: 'r',
          result: result({ text: 'print(1)', hash: 'SECRET' }),
        }),
        event(3, 'tool_execution_start', {
          toolName: 'read_next_skill',
          toolCallId: 's',
          args: { studentFeedback: 'INTERNAL' },
        }),
        event(4, 'tool_execution_end', {
          toolName: 'read_next_skill',
          toolCallId: 's',
          result: result({ section: 'A-teach.md', content: 'PROTOCOL' }),
        }),
        event(5, 'session_end', { status: 'succeeded' }),
      ],
      'coder',
      false,
    );
    expect(output[0]?.parts[0]).toMatchObject({
      name: 'read_file',
      args: { path: 'src/main.py', token: 'SECRET' },
      result: result({ text: 'print(1)', hash: 'SECRET' }),
      startedAt: 1,
      endedAt: 2,
    });
    expect(output[0]?.parts[1]).toMatchObject({ name: 'read_next_skill', status: 'succeeded' });
    expect(JSON.stringify(output)).toContain('SECRET');
    expect(JSON.stringify(output)).toContain('INTERNAL');
    expect(JSON.stringify(output)).toContain('PROTOCOL');
  });
  it('settles partial thinking and tool activity when the worker is interrupted', () => {
    const output = projectConversation(
      [
        event(1, 'message_update', {
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Working' }] },
        }),
        event(2, 'tool_execution_start', { toolName: 'run_build', toolCallId: 'build' }),
        event(3, 'session_interrupted', { reason: 'SECRET INFRASTRUCTURE' }),
      ],
      'coder',
      false,
    );
    expect(output[0]?.status).toBe('interrupted');
    expect(output[0]?.parts[0]).toMatchObject({ streaming: false, endedAt: 2 });
    expect(output[0]?.parts[1]).toMatchObject({ status: 'interrupted', endedAt: 3 });
    expect(JSON.stringify(output)).not.toContain('SECRET');
  });
  it('settles interrupted tools and retains saved review questions on a failed turn', () => {
    const history = [
      event(1, 'tool_execution_start', { toolName: 'run_build', toolCallId: 'b' }),
      event(2, 'tool_execution_end', {
        toolName: 'request_skill_review',
        toolCallId: 'q',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ question: 'Why this choice?', waitForStudent: true }),
            },
          ],
        },
      }),
    ];
    const output = projectConversation(history, 'planner', false);
    expect(output[0]!.parts[0]).toMatchObject({ status: 'interrupted' });
    expect(output[0]!.parts.at(-1)).toMatchObject({ text: 'Why this choice?' });
  });
  it('does not conflate retry attempts and preserves the failed tool result', () => {
    const output = projectConversation(
      [
        event(1, 'tool_execution_start', { toolName: 'read_file', toolCallId: 'x' }),
        event(
          2,
          'tool_execution_end',
          {
            toolName: 'read_file',
            toolCallId: 'x',
            isError: true,
            result: { error: 'secret provider URL' },
          },
          2,
        ),
      ],
      'coder',
      false,
    );
    expect(output).toHaveLength(2);
    expect(output[0]!.parts[0]).toMatchObject({ status: 'interrupted' });
    expect(output[1]!.parts[0]).toMatchObject({ status: 'failed' });
    expect(output[1]!.parts[0]).toMatchObject({ result: { error: 'secret provider URL' } });
  });
});
describe('general teaching protocols', () => {
  const definition = installedProject({ id: 'greeting-python-lab', version: '1.1.0' }).definition;
  function prompt(milestoneIndex: number, stageIndex: number) {
    const milestone = definition.milestones[milestoneIndex]!;
    const stage = milestone.stages[stageIndex]!;
    return renderTeachingPrompt({
      definition,
      milestone,
      stage,
      role: 'agent' in stage ? stage.agent : 'discussion',
      stageKey: `${milestone.id}:${stageIndex}`,
      packaged: false,
      skill: { ...stageSkill(stage), documents: [] },
      collected: startOrchestration(definition).state.collected[milestone.id]!,
    }).systemPrompt;
  }
  it('withholds lesson material until first-project readiness and gives a concise formatted welcome contract', () => {
    const milestone = structuredClone(definition.milestones[0]!);
    const stage = milestone.stages[0]!;
    const skill = {
      ...stageSkill(stage),
      documents: [{ path: 'lesson', text: 'LESSON_RESOURCE_SENTINEL' }],
    };
    const input = {
      definition,
      milestone,
      stage,
      role: 'discussion' as const,
      stageKey: `${milestone.id}:0`,
      packaged: false,
      skill,
      collected: startOrchestration(definition).state.collected[milestone.id]!,
      welcome: 'pending' as const,
    };
    const pending = renderTeachingPrompt(input).systemPrompt;
    expect(pending).toContain('three compact Markdown headings');
    expect(pending).toContain('Do not teach concepts');
    expect(pending).not.toContain('LESSON_RESOURCE_SENTINEL');
    const opening = teachingSection(input, skill.progression[1]!);
    expect(opening.referenceMaterials).toEqual([]);
    expect(JSON.stringify(opening)).not.toContain('LESSON_RESOURCE_SENTINEL');
    expect(
      JSON.stringify(teachingSection({ ...input, welcome: 'ready' }, skill.progression[1]!)),
    ).toContain('LESSON_RESOURCE_SENTINEL');
    expect(renderTeachingPrompt(input).sectionBytes).toBeGreaterThan(0);
  });
  it.each([0, 1])(
    'orders the formal opening and asks one question in milestone %s, including authored Skills',
    (index) => {
      const milestone = definition.milestones[index]!;
      const stage = milestone.stages[0]!;
      const skill = {
        ...stageSkill(stage),
        documents: [],
      };
      skill.content = { ...skill.content, [skill.progression[1]!]: 'Course-specific lesson.' };
      const input = {
        definition,
        milestone,
        stage,
        role: 'discussion' as const,
        stageKey: `${milestone.id}:0`,
        packaged: true,
        skill,
        collected: startOrchestration(definition).state.collected[milestone.id]!,
        welcome: index === 0 ? ('ready' as const) : undefined,
      };
      const policy = 'first state what the learner will accomplish';
      const rendered = renderTeachingPrompt(input).systemPrompt;
      const section = teachingSection(input, skill.progression[1]!);
      expect(rendered).toContain(policy);
      expect(section.delivery).toContain(policy);
      expect(section.delivery).toContain('End with ONE focused question');
      expect(section.instruction).toBe('Course-specific lesson.');
      expect(renderTeachingPrompt({ ...input, welcome: 'pending' }).systemPrompt).not.toContain(
        policy,
      );
      expect(
        teachingSection({ ...input, welcome: 'pending' }, skill.progression[1]!).delivery,
      ).not.toContain(policy);
    },
  );
  it('gives decision discussion neutral options and keeps a decision-free milestone immediately continuable', () => {
    const noDecisions = structuredClone(definition);
    noDecisions.milestones[0]!.decisions = [];
    const { state } = startOrchestration(noDecisions);
    state.position.stageIndex = 1;
    expect(allowedStudentActions(noDecisions, state)).toContain('next');
    const discussion = prompt(0, 1);
    expect(discussion).toContain('trade-offs neutrally');
    expect(discussion).toContain(
      'Only a learner submission through the project controls records a decision',
    );
    expect(discussion).toContain('no offered decisions');
    expect(discussion).not.toMatch(/rubricPreferences|answerKeys|correctOption/);
  });
  it('aligns the final recap handoff with the same project boundary used by complete_stage', () => {
    const lastIndex = definition.milestones.length - 1;
    expect(
      isFinalProjectRecap(
        definition,
        { milestoneIndex: 0, stageIndex: 6 },
        definition.milestones[0]!.stages[6]!,
      ),
    ).toBe(false);
    expect(prompt(0, 6)).toContain(
      'After the current completion gates succeed and productContext allows Continue, the learner uses the task bar above the chat input to enter the next step.',
    );
    expect(
      isFinalProjectRecap(
        definition,
        { milestoneIndex: lastIndex, stageIndex: 6 },
        definition.milestones[lastIndex]!.stages[6]!,
      ),
    ).toBe(true);
    expect(prompt(lastIndex, 6)).toContain(
      'Only a successful final recap complete_stage receipt completes the project and reveals the report',
    );
    expect(prompt(lastIndex, 6)).not.toContain(
      'After the current completion gates succeed and productContext allows Continue, the learner uses the task bar above the chat input to enter the next step.',
    );
  });
  it('does not mistake a named pre-decision skill for mentor reflection', () => {
    const skill = stageSkill({
      kind: 'mentor_say',
      agent: 'discussion',
      skill: 'discussion-pre-decision',
    } as StageDefinition);
    expect(skill.content['A-teach.md']).toContain('projectContext');
    expect(JSON.stringify(skill)).not.toMatch(/Future Self|Spring Boot|Java|M[0-9]/);
    const recap = stageSkill({
      kind: 'mentor_say',
      agent: 'mentor',
      skill: 'recap',
    } as StageDefinition);
    expect(recap.content['A-teach.md']).toContain('observed tests');
  });
  it('retains progressive review and current-host tool contracts', () => {
    const plan = stageSkill({ kind: 'produce', writes: 'plan' } as StageDefinition);
    expect(plan.progression).toEqual([
      'SKILL.md',
      'A-generate.md',
      'B-understand.md',
      'C-review.md',
      'D-approve.md',
    ]);
    expect(JSON.stringify(plan.content)).toContain('write_file');
    expect(JSON.stringify(plan.content)).not.toContain('`write`');
    expect(interactionRules).toContain('先在当前边界内正面解释');
    expect(interactionRules).toContain('真实新回复');
  });
});

it('protects the current reply independently of a later pending question fallback', () => {
  const text = 'Large current reply. '.repeat(120_000);
  const entries = projectConversation([event(1, 'message_end', message(text))], 'coder', false);
  const currentId = entries[0]!.id;
  entries.push({
    id: 'pending-question',
    speaker: 'coder',
    parts: [{ kind: 'text', id: 'q', text: 'Can you explain this?' }],
  });
  boundConversation(entries, 1024, new Set([`${currentId}:${entries[0]!.parts[0]!.id}`]));
  expect(entries[0]!.parts).toMatchObject([{ text }]);
});

it('bounds earlier model messages in a single long Agent turn without limiting the latest message', () => {
  const events = [event(1, 'user_message', { text: 'Please implement this.' })];
  const old = 'Older explanation. '.repeat(40_000);
  const current = 'Current reasoning and text. '.repeat(50_000);
  for (let n = 0; n < 12; n++) {
    events.push(event(2 + n * 3, 'message_start', message('')));
    events.push(event(3 + n * 3, 'message_end', message(old + n)));
  }
  events.push(event(100, 'message_start', message('')));
  events.push(event(101, 'message_update', message(current)));
  const entries = projectConversation(events, 'coder', true);
  expect(JSON.stringify(entries)).toContain(current);
  expect(Buffer.byteLength(JSON.stringify(entries))).toBeLessThan(
    Buffer.byteLength(current) + 550_000,
  );
  expect(entries.some((entry) => entry.omitted)).toBe(true);
});

it.each([false, true])(
  'presents one canonical full review across ordinary paraphrases and crash recovery (SDK receipt: %s)',
  (sdk) => {
    const response = 'The plan follows your saved choice.\n\nAny changes to this version?';
    const events = [
      event(1, 'user_message', { text: 'Review my plan.' }),
      event(2, 'message_end', {
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Private reasoning remains expandable.' },
            { type: 'text', text: 'The plan is ready. Do you want to change anything?' },
          ],
        },
      }),
      event(3, 'pbl_learner_handoff', { canonical: true, question: response, toolCallId: 'one' }),
      ...(sdk
        ? [
            event(4, 'tool_execution_end', {
              toolName: 'request_skill_review',
              toolCallId: 'one',
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      canonical: true,
                      response,
                      question: 'Any changes to this version?',
                    }),
                  },
                ],
              },
            }),
          ]
        : []),
      event(5, 'session_end', { status: 'succeeded' }),
    ];
    const before = structuredClone(events);
    const parts = projectConversation(events, 'planner', false)
      .filter((entry) => entry.speaker !== 'user')
      .flatMap((entry) => entry.parts);
    expect(parts.filter((part) => part.kind === 'text').map((part) => part.text)).toEqual([
      response,
    ]);
    expect(parts.some((part) => part.kind === 'thinking')).toBe(true);
    if (sdk)
      expect(
        parts.some((part) => part.kind === 'tool' && part.name === 'request_skill_review'),
      ).toBe(true);
    expect(events).toEqual(before);
  },
);

it('reconciles canonical delivery across pages without hiding another role session or a later learner turn', () => {
  const raw = projectConversation(
    [
      event(2, 'message_end', {
        ...message('Earlier prose with a paraphrased question.'),
        pblInputId: 1,
        pblMessageId: 2,
      }),
    ],
    'discussion',
    false,
    undefined,
    true,
  ).map((entry) => ({ ...entry, id: 'pbl-role-first:' + entry.id }));
  const receipt = projectConversation(
    [
      event(4, 'pbl_learner_handoff', {
        pblInputId: 1,
        question: 'Full explanation and one question.',
        canonical: true,
        toolCallId: 'canonical',
      }),
    ],
    'discussion',
    false,
    undefined,
    true,
  ).map((entry) => ({ ...entry, id: 'pbl-role-first:' + entry.id }));
  const another = raw.map((entry) => ({
    ...entry,
    id: entry.id.replace('pbl-role-first', 'pbl-role-other'),
  }));
  const merged = mergeConversationHistory([raw, another, receipt]);
  const texts = merged
    .flatMap((entry) => entry.parts)
    .filter((part) => part.kind === 'text')
    .map((part) => part.text);
  expect(texts).toEqual([
    'Earlier prose with a paraphrased question.',
    'Full explanation and one question.',
  ]);
  const failed = projectConversation(
    [
      event(1, 'user_message', { text: 'Explain.' }),
      event(2, 'message_end', message('Still visible until a handoff commits.')),
      event(3, 'tool_execution_end', {
        toolName: 'request_skill_review',
        toolCallId: 'failed',
        isError: true,
        result: {
          content: [
            { type: 'text', text: JSON.stringify({ canonical: true, response: 'Uncommitted.' }) },
          ],
        },
      }),
    ],
    'discussion',
    false,
  );
  expect(
    failed
      .filter((entry) => entry.speaker !== 'user')
      .flatMap((entry) => entry.parts)
      .filter((part) => part.kind === 'text')
      .map((part) => part.text),
  ).toEqual(['Still visible until a handoff commits.']);
});

it('retains the original message identity when a canonical recovery copies its exact text', () => {
  const response = 'Open Project files to read PLAN.md.';
  const before = [
    event(1, 'user_message', { text: 'Where is the plan?' }),
    event(2, 'message_end', message(response)),
  ];
  const original = projectConversation(before, 'planner', false)
    .flatMap((entry) => entry.parts)
    .find((part) => part.kind === 'text' && part.text === response)!;
  const recovered = projectConversation(
    [
      ...before,
      event(3, 'pbl_learner_handoff', {
        question: response,
        canonical: true,
        toolCallId: 'recovery',
      }),
    ],
    'planner',
    false,
  )
    .flatMap((entry) => entry.parts)
    .filter((part) => part.kind === 'text' && part.text === response);
  expect(recovered).toEqual([original]);
});

it.each([
  { blocks: ['The final explanation and question.'] },
  { blocks: ['The final explanation.', 'One closing question?'] },
])(
  'retains canonical receipts until separately projected history pages merge ($blocks.length blocks)',
  ({ blocks }) => {
    const draft = event(2, 'message_end', {
      ...message('An earlier draft which the committed reply replaces.'),
      pblInputId: 1,
      pblMessageId: 2,
    });
    const final = event(4, 'message_end', {
      message: { role: 'assistant', content: blocks.map((text) => ({ type: 'text', text })) },
      pblInputId: 1,
      pblMessageId: 4,
    });
    const receipt = event(5, 'pbl_learner_handoff', {
      question: blocks.join('\n'),
      canonical: true,
      toolCallId: 'page-receipt',
      pblInputId: 1,
    });
    const project = (events: PersistedAgentSessionEvent[], history: boolean) =>
      projectConversation(events, 'planner', false, undefined, history);
    const pages = [project([draft], true), project([final, receipt], true)];
    const saved = structuredClone(pages);
    const texts = (entries: ReturnType<typeof projectConversation>) =>
      entries
        .flatMap((e) => e.parts)
        .filter((p) => p.kind === 'text')
        .map((p) => p.text);
    expect(texts(mergeConversationHistory(pages))).toEqual(
      texts(project([draft, final, receipt], false)),
    );
    expect(texts(mergeConversationHistory(pages))).toEqual([blocks.join('\n')]);
    expect(pages).toEqual(saved);
  },
);
