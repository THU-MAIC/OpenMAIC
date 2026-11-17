/**
 * The backend half of an agent asking the user a question.
 *
 * A successful call emits the complete question envelope before returning.
 * The runner then terminates the current run, leaving the next ordinary user
 * message to requeue the conversation and supply the answer.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';

/** The complete question envelope, echoed in the tool result and event. */
export interface AskUserQuestion {
  question: string;
  /** Supporting material (a proposed plan, say), shown collapsed under the question. */
  details?: string;
  options?: { id: string; label: string; recommended?: true }[];
  multiSelect?: boolean;
}

export interface AskUserToolDeps {
  /** Emit the durable user-question lifecycle event. */
  onUserQuestion: (question: AskUserQuestion) => void;
}

/**
 * True for a question whose line breaks arrived as a backslash followed by `n`
 * (the model JSON-escaped the string twice) and that has no actual newline:
 * Markdown shows those two characters verbatim between the paragraphs.
 * Code spans and math are skipped, and so is a backslash+n that starts a
 * lowercase word (`\\neq`, `\\nabla`): those are text the user should see.
 */
function hasEscapedLineBreaks(question: string): boolean {
  if (question.includes('\n')) return false;
  const prose = question.replace(/`[^`]*`/g, '').replace(/\$[^$]*\$/g, '');
  return /\\n(?![a-z])/.test(prose);
}

const AskUserParams = Type.Object({
  question: Type.String({
    description:
      'The question itself, in one short line the user can answer at a glance. Put anything longer — a proposed plan, the reasoning behind the options — in details, not here. It is rendered as Markdown: break lines with actual newlines in the decoded string, never the two characters backslash+n.',
  }),
  details: Type.Optional(
    Type.String({
      description:
        'Optional supporting material the user may want before answering, such as the full plan you propose. Rendered as Markdown, collapsed under the question until the user opens it.',
    }),
  ),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({
          description: 'Stable, short option id. It must be unique across the options.',
        }),
        label: Type.String({
          description:
            'A short label of a few words; at most a brief qualifier, never a paragraph.',
        }),
        recommended: Type.Optional(
          Type.Boolean({
            description:
              'True on the one option you recommend. The interface may select it for the user when they do not respond within a few seconds, so mark it only when it is a choice you would act on yourself.',
          }),
        ),
      }),
      {
        description:
          "Optional multiple-choice options the interface can render as buttons. The interface always offers a free-text answer as the last row; to word that row yourself, give it the id 'other'. Mark at most one option as recommended, never the 'other' option.",
      },
    ),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({ description: 'True when the user may pick several options.' }),
  ),
});

export function buildAskUserTool(deps: AskUserToolDeps): AgentTool<typeof AskUserParams, unknown> {
  // The escaped-line-break check is a heuristic, so it rejects at most once per
  // tool instance (one run): a model that calls again, with the same text or
  // not, is taken at its word and the question is shown as written.
  let escapedLineBreaksRejected = false;
  return {
    name: 'ask_user',
    label: 'Ask the user',
    description:
      "Ask the user a question and end the turn. The current run stops, and the user's answer arrives as the next chat message. Use this for a decision the user must own instead of guessing. When one option is a sensible default you would proceed with — for example the plan you are proposing — mark it as recommended: the interface may choose it for a user who does not respond, and the user can still change course in a later message. Do not mark one when you lack information only the user can supply, such as a missing topic or an ambiguous target.",
    parameters: AskUserParams,
    async execute(_id, params: Static<typeof AskUserParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const question = params.question?.trim();
      if (!question) {
        return {
          content: [{ type: 'text' as const, text: 'ask_user needs a non-empty question.' }],
          details: { error: 'empty-question' },
          isError: true,
        };
      }

      if (!escapedLineBreaksRejected && hasEscapedLineBreaks(question)) {
        // Rejected rather than converted, as the edit tools do for the same
        // mistake: guessing which backslash+n were meant as text is the
        // post-processing the agent tools avoid.
        escapedLineBreaksRejected = true;
        return {
          content: [
            {
              type: 'text' as const,
              text: 'ask_user question uses literal backslash+n where line breaks were meant; the user would see the characters "\\n". Put actual newlines in the decoded string value, not its JSON-escaped representation, and call again. Text inside backtick code spans is not checked, so write a backslash+n the user should read as `\\n`. This check runs once: if the backslash+n was intended, call again with the same text and it is shown as written. No automatic conversion was applied.',
            },
          ],
          details: { error: 'escaped-newlines' },
          isError: true,
        };
      }

      const options =
        params.options && params.options.length > 0
          ? params.options
              .map((option) => ({
                id: String(option.id ?? '').trim(),
                label: String(option.label ?? '').trim(),
                ...(option.recommended === true ? { recommended: true as const } : {}),
              }))
              .filter((option) => option.id && option.label)
          : undefined;
      if (params.options && params.options.length > 0 && (!options || options.length === 0)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'ask_user options must have both a non-empty id and label.',
            },
          ],
          details: { error: 'invalid-options' },
          isError: true,
        };
      }

      if (options) {
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const option of options) {
          if (seen.has(option.id)) duplicates.add(option.id);
          seen.add(option.id);
        }
        if (duplicates.size > 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `ask_user option ids must be unique; these are repeated: ${[
                  ...duplicates,
                ].join(', ')}. Give every option its own id and call again.`,
              },
            ],
            details: { error: 'duplicate-option-ids', duplicates: [...duplicates] },
            isError: true,
          };
        }
      }

      if (options) {
        const recommended = options.filter((option) => option.recommended);
        if (recommended.length > 1 || recommended.some((option) => option.id === 'other')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: "ask_user accepts at most one recommended option, and the free-text 'other' option cannot be it. Mark the single option you would proceed with, or none, and call again.",
              },
            ],
            details: { error: 'invalid-recommended-option' },
            isError: true,
          };
        }
      }

      const details = params.details?.trim();
      const envelope: AskUserQuestion = {
        question,
        ...(details ? { details } : {}),
        ...(options ? { options } : {}),
        ...(params.multiSelect ? { multiSelect: true } : {}),
      };
      if (signal?.aborted) throw new Error('aborted');
      deps.onUserQuestion(envelope);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Question sent to the user: "${question}". The run stops here; the user's answer arrives as the next message.`,
          },
        ],
        details: envelope,
      };
    },
  };
}
