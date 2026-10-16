import { describe, expect, it } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { buildCueUserTool } from '@/lib/chat/pi/tools/cue-user';
import { normalizeCueUserOptions } from '@/lib/chat/cue-user-options';

describe('Pi chat cue_user tool', () => {
  it('describes option bounds without hard schema limits, with no client action schema', () => {
    const tool = buildCueUserTool({ getLastAgentId: () => 'default-1', cueUser: async () => true });
    const { prompt, options } = tool.parameters.properties as unknown as Record<
      'prompt' | 'options',
      { description?: string; items?: object }
    >;
    expect(options).toMatchObject({ type: 'array', items: { type: 'string' } });
    for (const key of ['minItems', 'maxItems']) expect(options).not.toHaveProperty(key);
    for (const key of ['minLength', 'maxLength']) {
      expect(options.items).not.toHaveProperty(key);
      expect(prompt).not.toHaveProperty(key);
    }
    expect(options.description).toMatch(/two to four/i);
    expect(options.description).toContain('60 characters');
    expect(prompt.description).toContain('240 characters');
  });

  it('accepts an over-limit call at validation and normalizes it in execute', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'default-1',
      cueUser: async (data) => {
        events.push(data);
        return true;
      },
    });
    const longLabel = 'x'.repeat(61);
    const args = {
      prompt: 'p'.repeat(300),
      options: ['One', longLabel, 'Three', 'Four', 'Five'],
    };
    const validated = validateToolArguments(tool, {
      type: 'toolCall',
      id: 'cue-over-limit',
      name: 'cue_user',
      arguments: args,
    });
    expect(validated).toEqual(args);

    const result = await tool.execute('cue-over-limit', validated);

    expect(result.details).toEqual({ emitted: true });
    expect(events).toEqual([
      {
        fromAgentId: 'default-1',
        prompt: 'p'.repeat(240),
        options: ['One', 'x'.repeat(60), 'Three', 'Four'],
      },
    ]);
  });

  it('emits normalized string suggestions only once', async () => {
    const events: unknown[] = [];
    let userCued = false;
    const tool = buildCueUserTool({
      getLastAgentId: () => 'default-1',
      cueUser: async (data) => {
        if (userCued) return false;
        userCued = true;
        events.push({ type: 'cue_user', data });
        return true;
      },
    });
    const first = await tool.execute('cue-1', {
      prompt: ' Any follow-up? ',
      options: [' Show an example ', 'Back to the lesson', ' Show an example '],
    });
    const second = await tool.execute('cue-2', { prompt: 'Again?' });
    expect(events).toEqual([
      {
        type: 'cue_user',
        data: {
          fromAgentId: 'default-1',
          prompt: 'Any follow-up?',
          options: ['Show an example', 'Back to the lesson'],
        },
      },
    ]);
    expect(first.details).toEqual({ emitted: true });
    expect(second.details).toEqual({ emitted: false });
  });

  it('normalizes 2-4 unique nonempty labels capped at60chars and omits a lone choice', () => {
    expect(normalizeCueUserOptions([' ', ' A ', 'A', 'x'.repeat(70), 'C', 'D', 'E'])).toEqual([
      'A',
      'x'.repeat(60),
      'C',
      'D',
    ]);
    expect(normalizeCueUserOptions([' ', ' A ', 'A'])).toBeUndefined();
    expect(normalizeCueUserOptions()).toBeUndefined();
  });

  it('does not emit cue_user before any classroom agent turn when guarded', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => undefined,
      canCueUser: () => false,
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([]);
    expect(result.details).toEqual({
      emitted: false,
      skipped: true,
      reason: 'no_agent_turns',
    });
  });

  it('soft-skips cue_user with a teacher substantive reason when configured', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'student-1',
      canCueUser: () => false,
      cueUserSkipReason: 'no_substantive_teacher_turn',
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([]);
    expect(result.details).toEqual({
      emitted: false,
      skipped: true,
      reason: 'no_substantive_teacher_turn',
    });
  });

  it('soft-skips cue_user with a teacher-or-assistant substantive reason when configured', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'student-1',
      canCueUser: () => false,
      cueUserSkipReason: 'no_substantive_teaching_turn',
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([]);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Call the teacher or teaching assistant for a visible answer before cueing the user.',
      },
    ]);
    expect(result.details).toEqual({
      emitted: false,
      skipped: true,
      reason: 'no_substantive_teaching_turn',
    });
  });

  it('allows cue_user after a teaching assistant substantive turn when guarded', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'assistant-1',
      canCueUser: () => true,
      cueUserSkipReason: 'no_substantive_teaching_turn',
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'assistant-1', prompt: 'Any follow-up?' },
      },
    ]);
    expect(result.details).toEqual({ emitted: true });
  });

  it('allows cue_user after a teacher substantive turn when guarded', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'teacher-1',
      canCueUser: () => true,
      cueUserSkipReason: 'no_substantive_teacher_turn',
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'teacher-1', prompt: 'Any follow-up?' },
      },
    ]);
    expect(result.details).toEqual({ emitted: true });
  });

  it('refuses cue_user after the session is closed', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'default-1',
      isSessionClosed: () => true,
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([]);
    expect(result.details).toEqual({
      emitted: false,
      skipped: true,
      reason: 'session_closed',
    });
  });

  it('skips call_agent after the user has already been cued', async () => {
    const tool = buildCallAgentTool({
      body: {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Stage' },
          scenes: [],
          currentSceneId: null,
          whiteboardOpen: false,
        },
        config: { agentIds: ['default-1'] },
        apiKey: '',
      } as never,
      agentConfigs: [],
      send: async () => {},
      languageModel: {} as never,
      onAgentDone: () => {},
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
      isUserCued: () => true,
    });

    const result = await tool.execute('call-1', {
      agentId: 'default-1',
      instruction: 'Please answer.',
    });

    expect(result.details).toEqual({ skipped: true, reason: 'user_already_cued' });
  });

  it('skips call_agent after the session is closed', async () => {
    const tool = buildCallAgentTool({
      body: {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Stage' },
          scenes: [],
          currentSceneId: null,
          whiteboardOpen: false,
        },
        config: { agentIds: ['default-1'] },
        apiKey: '',
      } as never,
      agentConfigs: [],
      send: async () => {},
      languageModel: {} as never,
      onAgentDone: () => {},
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
      isSessionClosed: () => true,
    });

    const result = await tool.execute('call-1', {
      agentId: 'default-1',
      instruction: 'Please answer.',
    });

    expect(result.details).toEqual({ skipped: true, reason: 'session_closed' });
  });

  it('counts rejected call_agent requests toward the hard attempt cap', async () => {
    const tool = buildCallAgentTool({
      body: {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Stage' },
          scenes: [],
          currentSceneId: null,
          whiteboardOpen: false,
        },
        config: { agentIds: ['default-1'] },
        apiKey: '',
      } as never,
      agentConfigs: [],
      send: async () => {},
      languageModel: {} as never,
      onAgentDone: () => {},
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 1,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
    });

    for (let i = 0; i < 4; i += 1) {
      await expect(
        tool.execute(`invalid-${i}`, {
          agentId: 'missing-agent',
          instruction: 'Please answer.',
        }),
      ).resolves.toMatchObject({
        details: { skipped: true, reason: 'invalid_agent_id' },
      });
    }

    await expect(
      tool.execute('over-cap', {
        agentId: 'missing-agent',
        instruction: 'Please answer.',
      }),
    ).resolves.toMatchObject({
      details: { skipped: true, reason: 'agent_attempt_cap', totalAgentAttempts: 4 },
    });
  });

  it('does not allow any call_agent after the agent turn budget is reached', async () => {
    const tool = buildCallAgentTool({
      body: {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Stage' },
          scenes: [],
          currentSceneId: null,
          whiteboardOpen: false,
        },
        config: { agentIds: ['teacher-1'] },
        apiKey: '',
      } as never,
      agentConfigs: [
        {
          id: 'teacher-1',
          name: 'Teacher',
          role: 'teacher',
          persona: 'Summarize clearly.',
          avatar: '',
          color: '#3366ff',
          allowedActions: [],
          priority: 10,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          isDefault: true,
        },
      ],
      send: async () => {},
      languageModel: {} as never,
      onAgentDone: () => {},
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 1,
      getAgentTurnCount: () => 1,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
    });

    expect(
      (tool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty('turnKind');

    const result = await tool.execute('call-1', {
      agentId: 'teacher-1',
      instruction: 'Give a final summary.',
    });

    expect(result.details).toEqual({
      skipped: true,
      reason: 'agent_turn_limit',
      maxAgentTurns: 1,
    });
  });
});
