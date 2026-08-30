import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import type { CoachErrorCode } from './coach-errors';

const CLOSED = { additionalProperties: false } as const;
const CANONICAL_TEXT_PATTERN = '^(?:\\S|\\S[\\s\\S]*\\S)$';
const IDENTIFIER_PATTERN = '^[^\\s\\u0000-\\u001f\\u007f]{1,128}$';
const IDENTIFIER = Type.String({ minLength: 1, maxLength: 128, pattern: IDENTIFIER_PATTERN });
const TRANSFER_QUESTION_TEXT = Type.String({
  minLength: 1,
  maxLength: 4_000,
  pattern: CANONICAL_TEXT_PATTERN,
});
const TRANSFER_DIFFICULTY = Type.Union([
  Type.Literal('same'),
  Type.Literal('slightly_easier'),
  Type.Literal('slightly_harder'),
]);
const TRANSFER_OPTION_SCHEMA = Type.Object(
  {
    id: IDENTIFIER,
    text: Type.String({ minLength: 1, maxLength: 1_000, pattern: CANONICAL_TEXT_PATTERN }),
  },
  CLOSED,
);
const TRANSFER_OPTIONS_SCHEMA = Type.Array(TRANSFER_OPTION_SCHEMA, {
  minItems: 3,
  maxItems: 6,
});

export const COACH_HINT_PRESENTATION_SCHEMA = Type.Object(
  {
    kind: Type.Literal('hint'),
    text: Type.String({
      minLength: 1,
      maxLength: 1_200,
      pattern: CANONICAL_TEXT_PATTERN,
    }),
  },
  CLOSED,
);

export const COACH_FULL_SOLUTION_PRESENTATION_SCHEMA = Type.Object(
  {
    kind: Type.Literal('full_solution'),
    explanation: Type.String({
      minLength: 1,
      maxLength: 12_000,
      pattern: CANONICAL_TEXT_PATTERN,
    }),
    finalAnswer: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2_000,
        pattern: CANONICAL_TEXT_PATTERN,
      }),
    ),
  },
  CLOSED,
);

export const COACH_NOTICE_PRESENTATION_SCHEMA = Type.Object(
  {
    kind: Type.Literal('coach_notice'),
    text: Type.String({
      minLength: 1,
      maxLength: 600,
      pattern: CANONICAL_TEXT_PATTERN,
    }),
  },
  CLOSED,
);

const TransferQuestionPresentationBase = {
  kind: Type.Literal('transfer_question'),
  transferQuestionId: IDENTIFIER,
  question: TRANSFER_QUESTION_TEXT,
  difficulty: TRANSFER_DIFFICULTY,
} as const;

export const COACH_TRANSFER_QUESTION_PRESENTATION_SCHEMA = Type.Union([
  Type.Object(
    {
      ...TransferQuestionPresentationBase,
      type: Type.Literal('single_choice'),
      options: TRANSFER_OPTIONS_SCHEMA,
    },
    CLOSED,
  ),
  Type.Object(
    {
      ...TransferQuestionPresentationBase,
      type: Type.Literal('multiple_choice'),
      options: TRANSFER_OPTIONS_SCHEMA,
    },
    CLOSED,
  ),
  Type.Object(
    {
      ...TransferQuestionPresentationBase,
      type: Type.Literal('numeric'),
    },
    CLOSED,
  ),
  Type.Object(
    {
      ...TransferQuestionPresentationBase,
      type: Type.Literal('exact_short_answer'),
    },
    CLOSED,
  ),
]);

export const COACH_TRANSFER_RESULT_MESSAGES = Object.freeze({
  correct: '这道迁移题答对了。',
  incorrect: '这次迁移还没有答对，先把这次结果记录下来。',
} as const);

export const COACH_TRANSFER_RESULT_PRESENTATION_SCHEMA = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('transfer_result'),
      outcome: Type.Literal('correct'),
      message: Type.Literal(COACH_TRANSFER_RESULT_MESSAGES.correct),
    },
    CLOSED,
  ),
  Type.Object(
    {
      kind: Type.Literal('transfer_result'),
      outcome: Type.Literal('incorrect'),
      message: Type.Literal(COACH_TRANSFER_RESULT_MESSAGES.incorrect),
    },
    CLOSED,
  ),
]);

/** The only student-visible terminal payloads a guarded Coach turn may publish. */
export const COACH_TERMINAL_PRESENTATION_SCHEMA = Type.Union([
  COACH_HINT_PRESENTATION_SCHEMA,
  COACH_FULL_SOLUTION_PRESENTATION_SCHEMA,
  COACH_TRANSFER_QUESTION_PRESENTATION_SCHEMA,
  COACH_TRANSFER_RESULT_PRESENTATION_SCHEMA,
  COACH_NOTICE_PRESENTATION_SCHEMA,
]);

export type CoachHintPresentation = Static<typeof COACH_HINT_PRESENTATION_SCHEMA>;
export type CoachFullSolutionPresentation = Static<typeof COACH_FULL_SOLUTION_PRESENTATION_SCHEMA>;
export type CoachTransferQuestionPresentation = Static<
  typeof COACH_TRANSFER_QUESTION_PRESENTATION_SCHEMA
>;
export type CoachTransferResultPresentation = Static<
  typeof COACH_TRANSFER_RESULT_PRESENTATION_SCHEMA
>;
export type CoachNoticePresentation = Static<typeof COACH_NOTICE_PRESENTATION_SCHEMA>;
export type CoachTerminalPresentation = Static<typeof COACH_TERMINAL_PRESENTATION_SCHEMA>;

export type CoachTerminalNoticeReason =
  | CoachErrorCode
  | 'NO_COACH_CALL'
  | 'WRONG_TOOL_CALLED'
  | 'COACH_TOOL_UNAVAILABLE'
  | 'COACH_TOOL_INPUT_INVALID'
  | 'COACH_TOOL_RESULT_INVALID'
  | 'COACH_AFTER_HOOK_FAILED'
  | 'COACH_PRESENTATION_NOT_PERSISTED';

const GENERIC_NOTICE =
  '这一步需要先按中考伴学流程处理。请把你的尝试发给我，或告诉我你需要一个提示。';
const LOCKED_NOTICE = '完整解析还未解锁。请先写下你的尝试；如果卡住了，可以先请求一个提示。';
const HINT_LIMIT_NOTICE = '当前提示流程已到达边界。请把你目前的尝试发给我，我们再继续处理。';
const MATERIAL_NOTICE =
  '当前材料无法完成可信来源验证，因此这次不会猜测来源或答案。请换用可验证的材料后再试。';
const CONFLICT_NOTICE = '伴学状态刚刚发生了变化。请同步当前状态后重试。';
const GENERATION_NOTICE = '这次内容暂时没有生成成功。请稍后重试，我不会用未经确认的内容替代。';
const PROFILE_NOTICE = '当前还没有可用的中考伴学画像。请先完成伴学模式的基础设置。';

/** Runtime-check and copy a public payload before it crosses a durable boundary. */
export function validateCoachTerminalPresentation(
  value: unknown,
): CoachTerminalPresentation | null {
  if (!Value.Check(COACH_TERMINAL_PRESENTATION_SCHEMA, value)) return null;
  const presentation = value as CoachTerminalPresentation;
  if (presentation.kind === 'hint') return { kind: 'hint', text: presentation.text };
  if (presentation.kind === 'coach_notice') {
    return { kind: 'coach_notice', text: presentation.text };
  }
  if (presentation.kind === 'transfer_question') {
    if (presentation.type === 'single_choice' || presentation.type === 'multiple_choice') {
      const options = presentation.options;
      const optionIds = options.map((option) => option.id);
      const optionTexts = options.map((option) =>
        option.text.normalize('NFKC').trim().replace(/\s+/gu, ' '),
      );
      if (
        new Set(optionIds).size !== optionIds.length ||
        new Set(optionTexts).size !== optionTexts.length
      ) {
        return null;
      }
      return {
        kind: 'transfer_question',
        transferQuestionId: presentation.transferQuestionId,
        type: presentation.type,
        question: presentation.question,
        options: options.map((option) => ({ ...option })),
        difficulty: presentation.difficulty,
      };
    }
    return {
      kind: 'transfer_question',
      transferQuestionId: presentation.transferQuestionId,
      type: presentation.type,
      question: presentation.question,
      difficulty: presentation.difficulty,
    };
  }
  if (presentation.kind === 'transfer_result') {
    return presentation.outcome === 'correct'
      ? {
          kind: 'transfer_result',
          outcome: 'correct',
          message: COACH_TRANSFER_RESULT_MESSAGES.correct,
        }
      : {
          kind: 'transfer_result',
          outcome: 'incorrect',
          message: COACH_TRANSFER_RESULT_MESSAGES.incorrect,
        };
  }
  return {
    kind: 'full_solution',
    explanation: presentation.explanation,
    ...(presentation.finalAnswer === undefined ? {} : { finalAnswer: presentation.finalAnswer }),
  };
}

/** Map only stable server state to fixed copy; arbitrary error text is never accepted. */
export function buildCoachNotice(reason: CoachTerminalNoticeReason): CoachNoticePresentation {
  let text = GENERIC_NOTICE;
  switch (reason) {
    case 'FULL_SOLUTION_LOCKED':
    case 'FULL_SOLUTION_REQUEST_REQUIRED':
    case 'STUDENT_ATTEMPT_REQUIRED':
    case 'COACH_ACTION_NOT_ALLOWED':
      text = LOCKED_NOTICE;
      break;
    case 'HINT_LIMIT_REACHED':
    case 'HINT_GENERATION_PENDING':
      text = HINT_LIMIT_NOTICE;
      break;
    case 'MATERIAL_SOURCE_NOT_SUPPORTED':
    case 'MATERIAL_SOURCE_NOT_VERIFIED':
      text = MATERIAL_NOTICE;
      break;
    case 'COACH_SESSION_CONFLICT':
    case 'COACH_EVENT_CONFLICT':
    case 'COACH_MESSAGE_ALREADY_COUNTED':
      text = CONFLICT_NOTICE;
      break;
    case 'HINT_GENERATION_FAILED':
    case 'HINT_CONTENT_INVALID':
    case 'HINT_CONTENT_LEAKED':
    case 'FULL_SOLUTION_GENERATION_FAILED':
    case 'FULL_SOLUTION_CONTENT_INVALID':
    case 'COACH_GENERATION_UNAVAILABLE':
    case 'COACH_RUNTIME_UNAVAILABLE':
    case 'TRANSFER_QUESTION_GENERATION_FAILED':
    case 'TRANSFER_QUESTION_INVALID':
    case 'TRANSFER_QUESTION_TYPE_UNSUPPORTED':
    case 'TRANSFER_QUESTION_NOT_VERIFIED':
    case 'TRANSFER_EVALUATION_FAILED':
    case 'ORIGINAL_ASSESSMENT_UNAVAILABLE':
    case 'ORIGINAL_ASSESSMENT_GENERATION_FAILED':
    case 'ORIGINAL_ASSESSMENT_INVALID':
    case 'ORIGINAL_ASSESSMENT_NOT_VERIFIED':
    case 'ORIGINAL_ATTEMPT_EVALUATION_FAILED':
    case 'ORIGINAL_ATTEMPT_EVALUATION_CONFLICT':
      text = GENERATION_NOTICE;
      break;
    case 'COACH_PROFILE_NOT_FOUND':
      text = PROFILE_NOTICE;
      break;
  }
  const presentation = validateCoachTerminalPresentation({ kind: 'coach_notice', text });
  if (!presentation || presentation.kind !== 'coach_notice') {
    throw new Error('Invalid server-owned Coach notice');
  }
  return presentation;
}

/** Render only fields from the validated public union, without model-authored copy. */
export function renderCoachTerminalPresentation(presentation: CoachTerminalPresentation): string {
  const validated = validateCoachTerminalPresentation(presentation);
  if (!validated) throw new Error('Invalid Coach terminal presentation');
  if (validated.kind === 'transfer_question') {
    const options =
      validated.type === 'single_choice' || validated.type === 'multiple_choice'
        ? validated.options.map((option) => `${option.id}. ${option.text}`).join('\n')
        : undefined;
    return options ? `${validated.question}\n\n${options}` : validated.question;
  }
  if (validated.kind === 'transfer_result') return validated.message;
  if (validated.kind === 'full_solution' && validated.finalAnswer !== undefined) {
    return `${validated.explanation}\n\n${validated.finalAnswer}`;
  }
  return validated.kind === 'full_solution' ? validated.explanation : validated.text;
}
