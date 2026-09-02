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
  options?: { id: string; label: string }[];
  multiSelect?: boolean;
}

export interface AskUserToolDeps {
  /** Emit the durable user-question lifecycle event. */
  onUserQuestion: (question: AskUserQuestion) => void;
}

const AskUserParams = Type.Object({
  question: Type.String({
    description: 'The question, phrased for the user to answer in chat. It must be self-contained.',
  }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({
          description: 'Stable, short option id. It must be unique across the options.',
        }),
        label: Type.String({ description: 'Human-readable option label.' }),
      }),
      {
        description: 'Optional multiple-choice options the interface can render as buttons.',
      },
    ),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({ description: 'True when the user may pick several options.' }),
  ),
});

export function buildAskUserTool(deps: AskUserToolDeps): AgentTool<typeof AskUserParams, unknown> {
  return {
    name: 'ask_user',
    label: 'Ask the user',
    description:
      "Ask the user a question and end the turn. The current run stops, and the user's answer arrives as the next chat message. Use this for a decision the user must own instead of guessing.",
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

      const options =
        params.options && params.options.length > 0
          ? params.options
              .map((option) => ({
                id: String(option.id ?? '').trim(),
                label: String(option.label ?? '').trim(),
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

      const envelope: AskUserQuestion = {
        question,
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
