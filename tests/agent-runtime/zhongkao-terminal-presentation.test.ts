import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';

import {
  buildCoachNotice,
  COACH_TRANSFER_RESULT_MESSAGES,
  renderCoachTerminalPresentation,
  validateCoachTerminalPresentation,
  type CoachTransferQuestionPresentation,
  type CoachTransferResultPresentation,
} from '@/lib/zhongkao/coach-public-presentation';
import {
  buildCoachTerminalPresentation,
  coachToolOutputCanSettle,
  createCoachFallbackCorrelation,
  createCoachPresentationAssistantMessage,
  createCoachPresentationCorrelation,
  inspectCoachPresentationEventData,
  inspectCoachPresentationPublication,
  parseCoachAfterToolCallContext,
  parseDurableCoachToolResult,
  planCoachPresentationPublication,
  recoverCoachToolPresentation,
  recoverDurableCoachToolCall,
  validateZhongkaoCoachToolOutput,
} from '@/lib/server/agent-runtime/zhongkao-terminal-presentation';
import { tagDurableUserMessage } from '@/lib/server/agent-runtime/trusted-turn';
import { interruptedToolResult } from '@/lib/server/agent-runtime/tool-call-integrity';
import {
  ZHONGKAO_COACH_TOOL_NAME,
  type CoachToolParams,
} from '@/lib/server/agent-runtime/zhongkao-coach-tool';

const MODEL = {
  api: 'openai-completions',
  provider: 'openai',
  id: 'driver-model',
} as const;

const HINT_PARAMS = {
  action: 'request_hint',
  profileId: 'profile-1',
  coachSessionId: 'coach-1',
  expectedRevision: 2,
} as const;

const GET_STATE_PARAMS = {
  action: 'get_state',
  profileId: 'profile-1',
  coachSessionId: 'coach-1',
} as const;

const SUBMIT_TRANSFER_PARAMS = {
  action: 'submit_transfer_answer',
  profileId: 'profile-1',
  coachSessionId: 'coach-1',
  expectedRevision: 2,
} as const;

const TRANSFER_QUESTION_PRESENTATION: CoachTransferQuestionPresentation = {
  kind: 'transfer_question',
  transferQuestionId: 'transfer-1',
  type: 'single_choice',
  question: '若 3x = 12，x 等于多少？',
  options: [
    { id: 'A', text: '2' },
    { id: 'B', text: '3' },
    { id: 'C', text: '4' },
  ],
  difficulty: 'same',
};

const TRANSFER_RESULT_PRESENTATION: CoachTransferResultPresentation = {
  kind: 'transfer_result',
  outcome: 'correct',
  message: COACH_TRANSFER_RESULT_MESSAGES.correct,
};

function output(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    facts: { replayed: false, eventAppended: true },
    allowedActions: [],
    ...overrides,
  };
}

function durableUser(text: string, seq: number): AgentMessage {
  return tagDurableUserMessage(
    { role: 'user', content: text, timestamp: 1 } as unknown as AgentMessage,
    seq,
  );
}

function durableResult(
  toolCallId: string,
  coachOutput: unknown,
  overrides: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: ZHONGKAO_COACH_TOOL_NAME,
    content: [{ type: 'text', text: JSON.stringify(coachOutput) }],
    details: coachOutput,
    isError: false,
    timestamp: 2,
    ...overrides,
  } as unknown as AgentMessage;
}

function durableCall(toolCallId: string, argumentsValue: unknown = HINT_PARAMS): AgentMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: toolCallId,
        name: ZHONGKAO_COACH_TOOL_NAME,
        arguments: argumentsValue,
      },
    ],
    stopReason: 'toolUse',
    timestamp: 2,
  } as unknown as AgentMessage;
}

function durablePreloadPair(toolCallId = 'call_sklpre_test'): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: toolCallId,
          name: 'read',
          arguments: { path: 'skills/agent-runtime/zhongkao-coach/SKILL.md', limit: 10 },
        },
      ],
      stopReason: 'toolUse',
      timestamp: 1,
    } as unknown as AgentMessage,
    {
      role: 'toolResult',
      toolCallId,
      toolName: 'read',
      content: [{ type: 'text', text: 'server-preloaded skill' }],
      details: { path: 'skills/agent-runtime/zhongkao-coach/SKILL.md' },
      isError: false,
      timestamp: 1,
    } as unknown as AgentMessage,
  ];
}

describe('Coach terminal public presentation', () => {
  it('requires durable proof for failures that can occur after a presentation request', () => {
    const fullSolution = {
      action: 'request_full_solution',
      profileId: 'profile-1',
      coachSessionId: 'coach-1',
      expectedRevision: 2,
    } as const;
    const unprovenMaterialFailure = output({
      ok: false,
      code: 'MATERIAL_SOURCE_NOT_VERIFIED',
      facts: { replayed: false, eventAppended: false },
    });
    expect(coachToolOutputCanSettle(fullSolution, unprovenMaterialFailure)).toBe(false);
    expect(
      coachToolOutputCanSettle(
        fullSolution,
        output({
          ok: false,
          code: 'MATERIAL_SOURCE_NOT_VERIFIED',
          facts: { replayed: true, eventAppended: false },
        }),
      ),
    ).toBe(true);
    expect(
      coachToolOutputCanSettle(
        {
          action: 'start_problem',
          profileId: 'profile-1',
          subjectId: 'math',
          knowledgePointIds: ['linear-equations'],
          questionSourceType: 'material',
          materialId: 'material-1',
        },
        unprovenMaterialFailure,
      ),
    ).toBe(true);
  });

  it('settles transfer presentations only for their exact action after durable proof', () => {
    const persistedQuestion = output({ presentation: TRANSFER_QUESTION_PRESENTATION });
    const persistedResult = output({ presentation: TRANSFER_RESULT_PRESENTATION });

    expect(coachToolOutputCanSettle(GET_STATE_PARAMS, persistedQuestion)).toBe(true);
    expect(coachToolOutputCanSettle(SUBMIT_TRANSFER_PARAMS, persistedResult)).toBe(true);
    expect(
      coachToolOutputCanSettle(
        GET_STATE_PARAMS,
        output({
          presentation: TRANSFER_QUESTION_PRESENTATION,
          facts: { replayed: false, eventAppended: false },
        }),
      ),
    ).toBe(false);
    expect(
      coachToolOutputCanSettle(
        SUBMIT_TRANSFER_PARAMS,
        output({
          presentation: TRANSFER_RESULT_PRESENTATION,
          facts: { replayed: false, eventAppended: false },
        }),
      ),
    ).toBe(false);
    expect(coachToolOutputCanSettle(GET_STATE_PARAMS, persistedResult)).toBe(true);
    expect(coachToolOutputCanSettle(SUBMIT_TRANSFER_PARAMS, persistedQuestion)).toBe(false);
    expect(coachToolOutputCanSettle(GET_STATE_PARAMS, output())).toBe(true);
    expect(coachToolOutputCanSettle(SUBMIT_TRANSFER_PARAMS, output())).toBe(false);
    expect(
      coachToolOutputCanSettle(
        GET_STATE_PARAMS,
        output({
          presentation: TRANSFER_RESULT_PRESENTATION,
          facts: { replayed: false, eventAppended: false },
        }),
      ),
    ).toBe(false);
  });

  it('settles proven errors only for the matching action and presentation family', () => {
    const fullSolution = {
      action: 'request_full_solution',
      profileId: 'profile-1',
      coachSessionId: 'coach-1',
      expectedRevision: 2,
    } as const;
    const provenError = (code: string) =>
      output({
        ok: false,
        code,
        facts: { replayed: false, eventAppended: true },
      });
    const hintOnlyCodes = [
      'HINT_GENERATION_FAILED',
      'HINT_CONTENT_INVALID',
      'HINT_CONTENT_LEAKED',
    ] as const;
    const fullSolutionOnlyCodes = [
      'COACH_PROFILE_NOT_FOUND',
      'FULL_SOLUTION_GENERATION_FAILED',
      'FULL_SOLUTION_CONTENT_INVALID',
      'COACH_GENERATION_UNAVAILABLE',
      'MATERIAL_SOURCE_NOT_SUPPORTED',
      'MATERIAL_SOURCE_NOT_VERIFIED',
    ] as const;

    for (const code of hintOnlyCodes) {
      expect(coachToolOutputCanSettle(HINT_PARAMS, provenError(code))).toBe(true);
      expect(coachToolOutputCanSettle(fullSolution, provenError(code))).toBe(false);
    }
    for (const code of fullSolutionOnlyCodes) {
      expect(coachToolOutputCanSettle(fullSolution, provenError(code))).toBe(true);
      expect(coachToolOutputCanSettle(HINT_PARAMS, provenError(code))).toBe(false);
    }
    for (const shared of ['COACH_SESSION_CONFLICT', 'COACH_RUNTIME_UNAVAILABLE'] as const) {
      expect(coachToolOutputCanSettle(HINT_PARAMS, provenError(shared))).toBe(true);
      expect(coachToolOutputCanSettle(fullSolution, provenError(shared))).toBe(true);
    }
    expect(coachToolOutputCanSettle(fullSolution, provenError('FULL_SOLUTION_LOCKED'))).toBe(true);

    const nonPresentationActions: CoachToolParams[] = [
      {
        action: 'start_problem',
        profileId: 'profile-1',
        subjectId: 'math',
        knowledgePointIds: ['linear-equations'],
        questionSourceType: 'typed',
      },
      { action: 'get_state', profileId: 'profile-1', coachSessionId: 'coach-1' },
      {
        action: 'submit_attempt',
        profileId: 'profile-1',
        coachSessionId: 'coach-1',
        expectedRevision: 2,
      },
      {
        action: 'submit_transfer_answer',
        profileId: 'profile-1',
        coachSessionId: 'coach-1',
        expectedRevision: 2,
      },
      {
        action: 'abandon_problem',
        profileId: 'profile-1',
        coachSessionId: 'coach-1',
        expectedRevision: 2,
      },
    ];
    for (const params of nonPresentationActions) {
      expect(coachToolOutputCanSettle(params, provenError('FULL_SOLUTION_GENERATION_FAILED'))).toBe(
        false,
      );
      expect(coachToolOutputCanSettle(params, provenError('HINT_CONTENT_INVALID'))).toBe(false);
      expect(coachToolOutputCanSettle(params, provenError('FULL_SOLUTION_LOCKED'))).toBe(false);
    }
  });

  it('settles original assessment failures only after a durable submit attempt', () => {
    const submitAttempt: CoachToolParams = {
      action: 'submit_attempt',
      profileId: 'profile-1',
      coachSessionId: 'coach-1',
      expectedRevision: 2,
    };
    const codes = [
      'ORIGINAL_ASSESSMENT_UNAVAILABLE',
      'ORIGINAL_ASSESSMENT_GENERATION_FAILED',
      'ORIGINAL_ASSESSMENT_INVALID',
      'ORIGINAL_ASSESSMENT_NOT_VERIFIED',
      'ORIGINAL_ATTEMPT_EVALUATION_FAILED',
      'ORIGINAL_ATTEMPT_EVALUATION_CONFLICT',
      'COACH_EVENT_CONFLICT',
    ] as const;

    for (const code of codes) {
      const appended = output({
        ok: false,
        code,
        facts: { replayed: false, eventAppended: true },
      });
      const replayed = output({
        ok: false,
        code,
        facts: { replayed: true, eventAppended: false },
      });
      const unproven = output({
        ok: false,
        code,
        facts: { replayed: false, eventAppended: false },
      });

      expect(coachToolOutputCanSettle(submitAttempt, appended), code).toBe(true);
      expect(coachToolOutputCanSettle(submitAttempt, replayed), code).toBe(true);
      expect(coachToolOutputCanSettle(submitAttempt, unproven), code).toBe(false);
      expect(coachToolOutputCanSettle(GET_STATE_PARAMS, appended), code).toBe(false);
    }
  });

  it('settles unproven rejections only for the action that can emit them before a write', () => {
    const unprovenError = (code: string) =>
      output({
        ok: false,
        code,
        facts: { replayed: false, eventAppended: false },
      });
    const materialStart: CoachToolParams = {
      action: 'start_problem',
      profileId: 'profile-1',
      subjectId: 'math',
      knowledgePointIds: ['linear-equations'],
      questionSourceType: 'material',
      materialId: 'material-1',
    };
    const typedStart: CoachToolParams = {
      action: 'start_problem',
      profileId: 'profile-1',
      subjectId: 'math',
      knowledgePointIds: ['linear-equations'],
      questionSourceType: 'typed',
    };
    const getState: CoachToolParams = {
      action: 'get_state',
      profileId: 'profile-1',
      coachSessionId: 'coach-1',
    };
    const submitAttempt: CoachToolParams = {
      action: 'submit_attempt',
      profileId: 'profile-1',
      coachSessionId: 'coach-1',
      expectedRevision: 2,
    };
    const submitTransfer: CoachToolParams = {
      action: 'submit_transfer_answer',
      profileId: 'profile-1',
      coachSessionId: 'coach-1',
      expectedRevision: 2,
    };

    expect(
      coachToolOutputCanSettle(materialStart, unprovenError('MATERIAL_SOURCE_NOT_VERIFIED')),
    ).toBe(true);
    expect(
      coachToolOutputCanSettle(typedStart, unprovenError('MATERIAL_SOURCE_NOT_VERIFIED')),
    ).toBe(false);
    expect(coachToolOutputCanSettle(getState, unprovenError('COACH_SESSION_NOT_FOUND'))).toBe(true);
    expect(coachToolOutputCanSettle(getState, unprovenError('HINT_LIMIT_REACHED'))).toBe(false);
    expect(
      coachToolOutputCanSettle(submitAttempt, unprovenError('COACH_MESSAGE_ALREADY_COUNTED')),
    ).toBe(true);
    expect(coachToolOutputCanSettle(submitAttempt, unprovenError('HINT_LIMIT_REACHED'))).toBe(
      false,
    );
    expect(coachToolOutputCanSettle(HINT_PARAMS, unprovenError('HINT_LIMIT_REACHED'))).toBe(true);
    expect(coachToolOutputCanSettle(HINT_PARAMS, unprovenError('TRANSFER_QUESTION_REQUIRED'))).toBe(
      false,
    );
    expect(
      coachToolOutputCanSettle(submitTransfer, unprovenError('TRANSFER_QUESTION_REQUIRED')),
    ).toBe(true);
    for (const code of [
      'TRANSFER_QUESTION_GENERATION_FAILED',
      'TRANSFER_QUESTION_INVALID',
      'TRANSFER_QUESTION_TYPE_UNSUPPORTED',
      'TRANSFER_QUESTION_NOT_VERIFIED',
    ] as const) {
      expect(coachToolOutputCanSettle(getState, unprovenError(code))).toBe(true);
    }
    for (const code of [
      'TRANSFER_QUESTION_NOT_VERIFIED',
      'TRANSFER_ANSWER_INVALID',
      'TRANSFER_EVALUATION_FAILED',
    ] as const) {
      expect(coachToolOutputCanSettle(submitTransfer, unprovenError(code))).toBe(true);
    }
    expect(
      coachToolOutputCanSettle(submitAttempt, unprovenError('TRANSFER_EVALUATION_FAILED')),
    ).toBe(false);
  });

  it('runtime-validates the closed hint, solution, transfer, and notice union', () => {
    expect(validateCoachTerminalPresentation({ kind: 'hint', text: '只提示一步' })).toEqual({
      kind: 'hint',
      text: '只提示一步',
    });
    expect(
      validateCoachTerminalPresentation({
        kind: 'full_solution',
        explanation: '这是解析',
        finalAnswer: '答案',
      }),
    ).toEqual({ kind: 'full_solution', explanation: '这是解析', finalAnswer: '答案' });
    expect(validateCoachTerminalPresentation(TRANSFER_QUESTION_PRESENTATION)).toEqual(
      TRANSFER_QUESTION_PRESENTATION,
    );
    expect(validateCoachTerminalPresentation(TRANSFER_RESULT_PRESENTATION)).toEqual(
      TRANSFER_RESULT_PRESENTATION,
    );
    expect(buildCoachNotice('NO_COACH_CALL').kind).toBe('coach_notice');

    expect(validateCoachTerminalPresentation({ kind: 'hint', text: ' padded ' })).toBeNull();
    expect(
      validateCoachTerminalPresentation({ kind: 'hint', text: 'ok', ownerId: 'private' }),
    ).toBeNull();
    expect(validateCoachTerminalPresentation({ kind: 'coach_notice', text: '' })).toBeNull();
    for (const secret of [
      'expectedAnswer',
      'acceptedAnswers',
      'answerKey',
      'correctOptionIds',
      'tolerance',
      'gradingSpec',
      'verifierReason',
    ]) {
      expect(
        validateCoachTerminalPresentation({
          ...TRANSFER_QUESTION_PRESENTATION,
          [secret]: 'PRIVATE-ANSWER-42',
        }),
      ).toBeNull();
    }
    expect(
      validateCoachTerminalPresentation({
        ...TRANSFER_RESULT_PRESENTATION,
        message: COACH_TRANSFER_RESULT_MESSAGES.incorrect,
      }),
    ).toBeNull();
    expect(
      validateCoachTerminalPresentation({
        ...TRANSFER_QUESTION_PRESENTATION,
        options: [
          TRANSFER_QUESTION_PRESENTATION.options[0],
          { id: 'A', text: 'duplicate id' },
          TRANSFER_QUESTION_PRESENTATION.options[2],
        ],
      }),
    ).toBeNull();
  });

  it('preserves accepted hint and full-solution fields exactly', () => {
    const hint = buildCoachTerminalPresentation({
      kind: 'tool_output',
      output: output({ presentation: { kind: 'hint', text: '先列已知条件。' } }),
    });
    expect(hint).toEqual({ kind: 'hint', text: '先列已知条件。' });
    expect(renderCoachTerminalPresentation(hint)).toBe('先列已知条件。');

    const solution = buildCoachTerminalPresentation({
      kind: 'tool_output',
      output: output({
        facts: { replayed: true, eventAppended: false },
        presentation: {
          kind: 'full_solution',
          explanation: '先化简，再代入。',
          finalAnswer: 'x = 2',
        },
      }),
    });
    expect(solution).toEqual({
      kind: 'full_solution',
      explanation: '先化简，再代入。',
      finalAnswer: 'x = 2',
    });
    expect(renderCoachTerminalPresentation(solution)).toBe('先化简，再代入。\n\nx = 2');
  });

  it('copies and renders only public transfer fields with fixed result text', () => {
    const question = buildCoachTerminalPresentation({
      kind: 'tool_output',
      output: output({ presentation: TRANSFER_QUESTION_PRESENTATION }),
    });
    const result = buildCoachTerminalPresentation({
      kind: 'tool_output',
      output: output({ presentation: TRANSFER_RESULT_PRESENTATION }),
    });
    expect(question).not.toBe(TRANSFER_QUESTION_PRESENTATION);
    if (question.kind !== 'transfer_question' || question.type !== 'single_choice') {
      throw new Error('unreachable');
    }
    expect(question.options).not.toBe(TRANSFER_QUESTION_PRESENTATION.options);
    expect(renderCoachTerminalPresentation(question)).toBe(
      '若 3x = 12，x 等于多少？\n\nA. 2\nB. 3\nC. 4',
    );
    if (result.kind !== 'transfer_result') throw new Error('unreachable');
    expect(renderCoachTerminalPresentation(result)).toBe(COACH_TRANSFER_RESULT_MESSAGES.correct);
  });

  it('fails closed when presentation persistence is not proven', () => {
    const presentation = buildCoachTerminalPresentation({
      kind: 'tool_output',
      output: output({
        facts: { replayed: false, eventAppended: false },
        presentation: { kind: 'hint', text: 'unproven candidate' },
      }),
    });
    expect(presentation.kind).toBe('coach_notice');
    expect(JSON.stringify(presentation)).not.toContain('unproven candidate');
  });

  it('uses the fixed durable-unavailable notice without exposing assessment internals', () => {
    const expected = {
      kind: 'coach_notice' as const,
      text: '当前无法可靠自动判断这类作答是否正确。你仍可以继续尝试或请求提示；完整解析解锁后也可以继续学习。',
    };
    expect(buildCoachNotice('ORIGINAL_ASSESSMENT_UNAVAILABLE')).toEqual(expected);
    const presentation = buildCoachTerminalPresentation({
      kind: 'tool_output',
      output: output({
        ok: false,
        code: 'ORIGINAL_ASSESSMENT_UNAVAILABLE',
        facts: { replayed: false, eventAppended: true },
      }),
    });
    expect(presentation).toEqual(expected);
    expect(renderCoachTerminalPresentation(presentation)).toBe(expected.text);
    expect(JSON.stringify(presentation)).not.toMatch(
      /unsupported_question_type|original_assessment_unavailable|questionFingerprint|unavailableEventId|gradingSpec|verificationRef/u,
    );
  });

  it('uses distinct fixed notices for required stable error categories', () => {
    const reasons = [
      'FULL_SOLUTION_LOCKED',
      'HINT_LIMIT_REACHED',
      'MATERIAL_SOURCE_NOT_VERIFIED',
      'COACH_SESSION_CONFLICT',
      'FULL_SOLUTION_GENERATION_FAILED',
      'COACH_PROFILE_NOT_FOUND',
      'NO_COACH_CALL',
    ] as const;
    const notices = reasons.map((reason) => buildCoachNotice(reason));
    expect(new Set(notices.map((notice) => notice.text))).toHaveLength(reasons.length);
    for (const notice of notices) {
      expect(notice.kind).toBe('coach_notice');
      expect(JSON.stringify(notice)).not.toMatch(
        /owner-private|session-private|call-private|provider exploded|raw database/i,
      );
    }
    expect(buildCoachNotice('TRANSFER_QUESTION_NOT_VERIFIED')).toEqual(
      buildCoachNotice('FULL_SOLUTION_GENERATION_FAILED'),
    );
  });

  it('ignores presentation attached to an error and never accepts raw error text', () => {
    const presentation = buildCoachTerminalPresentation({
      kind: 'tool_output',
      output: output({
        ok: false,
        code: 'FULL_SOLUTION_LOCKED',
        facts: { replayed: false, eventAppended: false },
        presentation: { kind: 'full_solution', explanation: 'provider exploded: answer 42' },
      }),
    });
    expect(presentation.kind).toBe('coach_notice');
    expect(JSON.stringify(presentation)).not.toContain('provider exploded');
    expect(JSON.stringify(presentation)).not.toContain('42');
  });
});

describe('Coach result parsing', () => {
  it('validates details first for live and durable results', () => {
    const accepted = output({ presentation: { kind: 'hint', text: '可信提示' } });
    const live = parseCoachAfterToolCallContext({
      toolCall: {
        id: 'call-1',
        name: ZHONGKAO_COACH_TOOL_NAME,
        arguments: HINT_PARAMS,
      },
      result: {
        details: accepted,
        content: [{ type: 'text', text: JSON.stringify(output({ ok: false })) }],
      },
    });
    expect(live).toEqual({ toolCallId: 'call-1', params: HINT_PARAMS, output: accepted });

    const durable = parseDurableCoachToolResult(durableResult('call-1', accepted));
    expect(durable).toEqual({ toolCallId: 'call-1', output: accepted });
  });

  it('recovers one schema-valid durable Coach call with no authoritative receipt', () => {
    const call = durableCall('call-recover');
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [durableUser('请给提示', 7), call],
        userMessageSeq: 7,
      }),
    ).toEqual({
      status: 'recoverable',
      toolCallId: 'call-recover',
      params: {
        action: 'request_hint',
        profileId: 'profile-1',
        coachSessionId: 'coach-1',
        expectedRevision: 2,
      },
    });

    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [
          durableUser('请给提示', 7),
          call,
          interruptedToolResult({ id: 'call-recover', name: ZHONGKAO_COACH_TOOL_NAME }),
        ],
        userMessageSeq: 7,
      }).status,
    ).toBe('recoverable');
  });

  it('replays malformed, empty, timeout, or contradictory receipts but not completed calls', () => {
    const accepted = output({ presentation: { kind: 'hint', text: '已持久化提示' } });
    const call = durableCall('call-uncertain');
    const uncertainReceipts = [
      durableResult('call-uncertain', accepted, {
        details: { bad: true },
        content: [{ type: 'text', text: JSON.stringify(accepted) }],
      }),
      durableResult('call-uncertain', accepted, {
        details: undefined,
        content: [],
        isError: true,
      }),
      durableResult('call-uncertain', accepted, {
        details: {
          name: 'AgentToolTimeoutError',
          message: 'tool deadline elapsed',
        },
        content: [{ type: 'text', text: 'tool deadline elapsed' }],
        isError: true,
      }),
      durableResult('call-uncertain', accepted, { isError: true }),
    ];

    for (const receipt of uncertainReceipts) {
      expect(
        recoverCoachToolPresentation({
          cursorMessages: [durableUser('请给提示', 7), call, receipt],
          agentSessionId: 'session-7',
          userMessageSeq: 7,
        }),
      ).toBeNull();
      expect(
        recoverDurableCoachToolCall({
          cursorMessages: [durableUser('请给提示', 7), call, receipt],
          userMessageSeq: 7,
        }),
      ).toMatchObject({
        status: 'recoverable',
        toolCallId: 'call-uncertain',
      });
    }

    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [
          durableUser('请给提示', 7),
          call,
          durableResult('call-uncertain', accepted),
        ],
        userMessageSeq: 7,
      }),
    ).toEqual({ status: 'invalid' });
  });

  it('does not settle a presentation whose type contradicts the durable action', () => {
    const call = durableCall('call-hint');
    const fullSolution = output({
      presentation: {
        kind: 'full_solution',
        explanation: '不应由提示动作发布',
        finalAnswer: '42',
      },
    });
    const messages = [durableUser('只给提示', 7), call, durableResult('call-hint', fullSolution)];

    expect(
      recoverCoachToolPresentation({
        cursorMessages: messages,
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    ).toBeNull();
    expect(
      recoverDurableCoachToolCall({ cursorMessages: messages, userMessageSeq: 7 }),
    ).toMatchObject({ status: 'recoverable', toolCallId: 'call-hint' });
  });

  it('allows complete forced-skill preload pairs before the orphaned Coach call', () => {
    const preload = durablePreloadPair();
    const call = durableCall('call-after-preload');
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [durableUser('请给提示', 7), ...preload, call],
        userMessageSeq: 7,
      }),
    ).toEqual({
      status: 'recoverable',
      toolCallId: 'call-after-preload',
      params: {
        action: 'request_hint',
        profileId: 'profile-1',
        coachSessionId: 'coach-1',
        expectedRevision: 2,
      },
    });
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [durableUser('只完成预载', 7), ...preload],
        userMessageSeq: 7,
      }),
    ).toEqual({ status: 'absent' });
  });

  it('rejects incomplete preload prefixes and any tool call after the Coach call', () => {
    const [preloadCall] = durablePreloadPair();
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [
          durableUser('预载未完成', 7),
          preloadCall!,
          durableCall('call-after-incomplete-preload'),
        ],
        userMessageSeq: 7,
      }),
    ).toEqual({ status: 'invalid' });
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [
          durableUser('Coach 后出现额外调用', 7),
          durableCall('call-first'),
          ...durablePreloadPair('call-after-coach'),
        ],
        userMessageSeq: 7,
      }),
    ).toEqual({ status: 'invalid' });
  });

  it('fails closed on multiple, wrong, or schema-invalid durable calls', () => {
    const valid = durableCall('call-valid');
    const multipleCalls = [
      durableUser('第一轮', 7),
      valid,
      durableCall('call-second'),
      durableResult(
        'call-valid',
        output({ presentation: { kind: 'hint', text: '不能消除多调用歧义' } }),
      ),
    ];
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: multipleCalls,
        userMessageSeq: 7,
      }),
    ).toEqual({ status: 'invalid' });
    expect(
      recoverCoachToolPresentation({
        cursorMessages: multipleCalls,
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    ).toBeNull();
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [
          durableUser('第一轮', 7),
          durableCall('call-wrong', { action: 'request_hint' }),
        ],
        userMessageSeq: 7,
      }),
    ).toEqual({ status: 'invalid' });
    const wrongTool = structuredClone(valid) as AgentMessage;
    if (wrongTool.role === 'assistant') {
      const block = wrongTool.content[0];
      if (block?.type === 'toolCall') block.name = 'read';
    }
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [durableUser('第一轮', 7), wrongTool],
        userMessageSeq: 7,
      }),
    ).toEqual({ status: 'invalid' });
  });

  it('requires receipts to match a real Coach call by id, name, and error status', () => {
    const accepted = output({ presentation: { kind: 'hint', text: '可信提示' } });
    const call = durableCall('call-match');

    const noCall = [durableUser('第一轮', 7), durableResult('call-match', accepted)];
    expect(
      recoverCoachToolPresentation({
        cursorMessages: noCall,
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    ).toBeNull();
    expect(recoverDurableCoachToolCall({ cursorMessages: noCall, userMessageSeq: 7 })).toEqual({
      status: 'invalid',
    });

    for (const mismatchedReceipt of [
      durableResult('call-other', accepted),
      durableResult('call-match', accepted, { toolName: 'read' }),
    ]) {
      expect(
        recoverCoachToolPresentation({
          cursorMessages: [durableUser('第一轮', 7), call, mismatchedReceipt],
          agentSessionId: 'session-7',
          userMessageSeq: 7,
        }),
      ).toBeNull();
      expect(
        recoverDurableCoachToolCall({
          cursorMessages: [durableUser('第一轮', 7), call, mismatchedReceipt],
          userMessageSeq: 7,
        }),
      ).toEqual({ status: 'invalid' });
    }

    const contradictoryErrorFlag = durableResult('call-match', accepted, { isError: true });
    expect(
      recoverCoachToolPresentation({
        cursorMessages: [durableUser('第一轮', 7), call, contradictoryErrorFlag],
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    ).toBeNull();
    expect(
      recoverDurableCoachToolCall({
        cursorMessages: [durableUser('第一轮', 7), call, contradictoryErrorFlag],
        userMessageSeq: 7,
      }),
    ).toMatchObject({ status: 'recoverable', toolCallId: 'call-match' });
  });

  it('uses content JSON only when details are absent', () => {
    const accepted = output({ presentation: { kind: 'hint', text: '可信提示' } });
    const parsed = parseDurableCoachToolResult(
      durableResult('call-json', accepted, { details: undefined }),
    );
    expect(parsed).toEqual({ toolCallId: 'call-json', output: accepted });

    const malformedDetails = durableResult('call-bad', accepted, {
      details: { ...accepted, internal: 'must fail closed' },
    });
    expect(parseDurableCoachToolResult(malformedDetails)).toBeNull();
  });

  it('rejects wrong tools, invalid JSON, extra DTO fields, and malformed envelopes', () => {
    const accepted = output();
    expect(
      parseCoachAfterToolCallContext({
        toolCall: { id: 'call-1', name: 'read' },
        result: { details: accepted },
      }),
    ).toBeNull();
    expect(
      parseCoachAfterToolCallContext({
        toolCall: { id: 'call-1', name: ZHONGKAO_COACH_TOOL_NAME },
        result: { details: accepted },
      }),
    ).toBeNull();
    expect(
      parseCoachAfterToolCallContext({
        toolCall: {
          id: 'call-1',
          name: ZHONGKAO_COACH_TOOL_NAME,
          arguments: { ...HINT_PARAMS, ownerId: 'forged-private-owner' },
        },
        result: { details: accepted },
      }),
    ).toBeNull();
    expect(
      parseDurableCoachToolResult(
        durableResult('call-1', accepted, {
          details: undefined,
          content: [{ type: 'text', text: '{not json' }],
        }),
      ),
    ).toBeNull();
    expect(validateZhongkaoCoachToolOutput({ ...accepted, internalId: 'private' })).toBeNull();
    expect(parseDurableCoachToolResult(null)).toBeNull();
  });
});

describe('Coach durable publication', () => {
  it('creates deterministic opaque correlations and exact assistant text', () => {
    const input = {
      agentSessionId: 'session-private',
      userMessageSeq: 17,
    };
    const correlation = createCoachPresentationCorrelation(input);
    expect(createCoachPresentationCorrelation(input)).toBe(correlation);
    expect(
      createCoachPresentationCorrelation({ ...input, userMessageSeq: input.userMessageSeq + 1 }),
    ).not.toBe(correlation);

    const presentation = { kind: 'hint' as const, text: '提示原文' };
    const message = createCoachPresentationAssistantMessage({
      presentation,
      correlation,
      now: () => 123,
    });
    expect(message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '提示原文' }],
      stopReason: 'stop',
      timestamp: 123,
      api: 'unknown',
      provider: 'openmaic-server',
      model: 'zhongkao-coach',
    });
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain(input.agentSessionId);
    expect(serialized).not.toContain('call-private');
    expect(serialized).not.toContain('owner-private');
  });

  it('uses a separate retry-stable domain for provenance-failure notices', () => {
    const fallback = createCoachFallbackCorrelation({
      agentSessionId: 'session-private',
      fallbackUserMessageSeq: 17,
    });
    expect(
      createCoachFallbackCorrelation({
        agentSessionId: 'session-private',
        fallbackUserMessageSeq: 17,
      }),
    ).toBe(fallback);
    expect(fallback).toMatch(/^coach-fallback-v1:/);
    expect(
      createCoachPresentationCorrelation({ agentSessionId: 'session-private', userMessageSeq: 17 }),
    ).not.toBe(fallback);
    for (const invalidSeq of [0, -1]) {
      expect(() =>
        createCoachFallbackCorrelation({
          agentSessionId: 'session-private',
          fallbackUserMessageSeq: invalidSeq,
        }),
      ).toThrow('Invalid Coach fallback correlation input');
    }
  });

  it('detects an existing publication and plans no duplicate on retry', () => {
    const correlation = createCoachPresentationCorrelation({
      agentSessionId: 'session-a',
      userMessageSeq: 3,
    });
    const presentation = { kind: 'hint' as const, text: '同一条提示' };
    const first = planCoachPresentationPublication({
      cursorMessages: [],
      presentation,
      correlation,
      model: MODEL,
      now: () => 10,
    });
    expect(first.kind).toBe('append');
    if (first.kind !== 'append') throw new Error('unreachable');

    expect(inspectCoachPresentationPublication([first.message], correlation)).toMatchObject({
      status: 'published',
      presentation,
    });
    expect(
      inspectCoachPresentationEventData({ message: first.message }, correlation),
    ).toMatchObject({ status: 'published', presentation });
    const retry = planCoachPresentationPublication({
      cursorMessages: [first.message],
      presentation,
      correlation,
      model: MODEL,
      now: () => 99,
    });
    expect(retry.kind).toBe('already-published');
    if (retry.kind === 'already-published') expect(retry.message).toBe(first.message);
  });

  it('replays an identical transfer question and conflicts on any public field change', () => {
    const correlation = createCoachPresentationCorrelation({
      agentSessionId: 'session-transfer',
      userMessageSeq: 4,
    });
    const first = planCoachPresentationPublication({
      cursorMessages: [],
      presentation: TRANSFER_QUESTION_PRESENTATION,
      correlation,
      model: MODEL,
    });
    if (first.kind !== 'append') throw new Error('unreachable');

    expect(
      planCoachPresentationPublication({
        cursorMessages: [first.message],
        presentation: structuredClone(TRANSFER_QUESTION_PRESENTATION),
        correlation,
      }).kind,
    ).toBe('already-published');
    expect(
      planCoachPresentationPublication({
        cursorMessages: [first.message],
        presentation: {
          ...TRANSFER_QUESTION_PRESENTATION,
          options: [
            TRANSFER_QUESTION_PRESENTATION.options[0],
            { ...TRANSFER_QUESTION_PRESENTATION.options[1], text: 'PRIVATE-ANSWER-42' },
            TRANSFER_QUESTION_PRESENTATION.options[2],
          ],
        },
        correlation,
      }),
    ).toEqual({ kind: 'conflict', correlation });
  });

  it('fails closed on duplicate, mismatched, or tampered correlation records', () => {
    const correlation = createCoachPresentationCorrelation({
      agentSessionId: 'session-a',
      userMessageSeq: 3,
    });
    const presentation = { kind: 'hint' as const, text: '同一条提示' };
    const message = createCoachPresentationAssistantMessage({
      presentation,
      correlation,
      model: MODEL,
    });
    expect(inspectCoachPresentationPublication([message, message], correlation)).toEqual({
      status: 'conflict',
    });

    expect(
      planCoachPresentationPublication({
        cursorMessages: [message],
        presentation: { kind: 'hint', text: '被篡改的提示' },
        correlation,
        model: MODEL,
      }),
    ).toEqual({ kind: 'conflict', correlation });

    const tampered = structuredClone(message) as AgentMessage;
    if (tampered.role === 'assistant') tampered.content = [{ type: 'text', text: '被篡改' }];
    expect(inspectCoachPresentationPublication([tampered], correlation)).toEqual({
      status: 'conflict',
    });
  });

  it('recovers the exact persisted presentation after a tool receipt checkpoint', () => {
    const accepted = output({
      facts: { replayed: true, eventAppended: false },
      presentation: { kind: 'full_solution', explanation: '持久化解析', finalAnswer: '2' },
    });
    const call = durableCall('call-7', {
      action: 'request_full_solution',
      profileId: 'profile-1',
      coachSessionId: 'coach-1',
      expectedRevision: 2,
    });
    const recovered = recoverCoachToolPresentation({
      cursorMessages: [
        durableUser('请解析', 7),
        ...durablePreloadPair(),
        call,
        durableResult('call-7', accepted),
      ],
      agentSessionId: 'session-7',
      userMessageSeq: 7,
    });
    expect(recovered).toMatchObject({
      toolCallId: 'call-7',
      presentation: { kind: 'full_solution', explanation: '持久化解析', finalAnswer: '2' },
    });
    expect(recovered?.correlation).toBe(
      createCoachPresentationCorrelation({
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    );
  });

  it('never crosses into a later user turn and rejects malformed or ambiguous receipts', () => {
    const accepted = output({ presentation: { kind: 'hint', text: '第二轮提示' } });
    const later = durableUser('第二轮', 8);
    expect(
      recoverCoachToolPresentation({
        cursorMessages: [
          durableUser('第一轮', 7),
          later,
          durableCall('call-8'),
          durableResult('call-8', accepted),
        ],
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    ).toBeNull();

    const malformed = durableResult('call-bad', accepted, {
      details: { bad: true },
      content: [{ type: 'text', text: JSON.stringify(accepted) }],
    });
    expect(
      recoverCoachToolPresentation({
        cursorMessages: [durableUser('第一轮', 7), durableCall('call-bad'), malformed],
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    ).toBeNull();

    expect(
      recoverCoachToolPresentation({
        cursorMessages: [
          durableUser('第一轮', 7),
          durableCall('call-bad'),
          malformed,
          durableResult('call-valid', accepted),
        ],
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    ).toBeNull();

    expect(
      recoverCoachToolPresentation({
        cursorMessages: [
          durableUser('第一轮', 7),
          durableCall('call-a'),
          durableResult('call-a', accepted),
          durableResult('call-a', accepted),
        ],
        agentSessionId: 'session-7',
        userMessageSeq: 7,
      }),
    ).toBeNull();
  });
});
