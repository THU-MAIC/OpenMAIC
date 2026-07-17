import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import type { StatelessEvent } from '@/lib/types/chat';

const CueUserParams = Type.Object({
  prompt: Type.Optional(
    Type.String({
      description: 'Optional short prompt for handing the turn back to the user.',
    }),
  ),
});

type CueUserParams = Static<typeof CueUserParams>;

type CueUserSkipReason =
  | 'no_agent_turns'
  | 'no_substantive_teacher_turn'
  | 'no_substantive_teaching_turn';

export function buildCueUserTool(opts: {
  cueUser: (data: Extract<StatelessEvent, { type: 'cue_user' }>['data']) => Promise<boolean>;
  getLastAgentId: () => string | undefined;
  canCueUser?: () => boolean;
  cueUserSkipReason?: CueUserSkipReason;
  isSessionClosed?: () => boolean;
}): AgentTool<typeof CueUserParams> {
  return {
    name: 'cue_user',
    label: 'Cue user',
    description:
      'Hand the classroom turn back to the user after the useful classroom agent turns are complete.',
    parameters: CueUserParams,
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: CueUserParams) => {
      if (opts.isSessionClosed?.()) {
        return {
          content: [
            {
              type: 'text',
              text: 'The classroom session is already closed. Do not cue the user again.',
            },
          ],
          details: { emitted: false, skipped: true, reason: 'session_closed' },
        };
      }

      if (opts.canCueUser && !opts.canCueUser()) {
        const reason = opts.cueUserSkipReason ?? 'no_agent_turns';
        return {
          content: [
            {
              type: 'text',
              text:
                reason === 'no_substantive_teacher_turn'
                  ? 'Call the teacher for a visible answer before cueing the user.'
                  : reason === 'no_substantive_teaching_turn'
                    ? 'Call the teacher or teaching assistant for a visible answer before cueing the user.'
                    : 'Call at least one classroom agent before cueing the user.',
            },
          ],
          details: { emitted: false, skipped: true, reason },
        };
      }

      const emitted = await opts.cueUser({
        fromAgentId: opts.getLastAgentId(),
        prompt: params.prompt,
      });
      return {
        content: [
          {
            type: 'text',
            text: emitted
              ? 'The user has been cued for the next classroom turn.'
              : 'The user was already cued for this classroom turn.',
          },
        ],
        details: { emitted },
      };
    },
  };
}
