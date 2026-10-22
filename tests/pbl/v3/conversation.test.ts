import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { projectConversation, learningRunFailure } from '@/lib/server/pbl-v3/conversation';
import { stageSkill, interactionRules } from '@/lib/server/pbl-v3/skills';
import type { PersistedAgentSessionEvent } from '@openmaic/storage';
import type { StageDefinition } from '@/lib/pbl/v3/domain/project/project-schema';

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
      'failed',
    ]);
    expect(output[1]?.parts[0]).toMatchObject({ text: 'Partial', streaming: false });
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
  it('updates a single text block and preserves tool order without revealing payloads', () => {
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
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|SECRET/);
  });
  it('streams real thinking before text, freezes duration and replays without duplicate blocks', () => {
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
        id: 'thinking-3-0',
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
  it('exposes project file details and skill activity without publishing control receipts or protocols', () => {
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
      args: { path: 'src/main.py' },
      result: 'print(1)',
      startedAt: 1,
      endedAt: 2,
    });
    expect(output[0]?.parts[1]).toMatchObject({ name: 'read_next_skill', status: 'succeeded' });
    expect(JSON.stringify(output)).not.toMatch(/SECRET|INTERNAL|PROTOCOL/);
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
  it('does not conflate retry attempts or publish failed tool diagnostics', () => {
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
    expect(JSON.stringify(output)).not.toContain('provider');
  });
});
describe('general teaching protocols', () => {
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
