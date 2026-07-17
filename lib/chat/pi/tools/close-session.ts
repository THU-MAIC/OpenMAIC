import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';

const CloseSessionParams = Type.Object({
  endReason: Type.Optional(
    Type.Union(
      [
        Type.Literal('user_goodbye'),
        Type.Literal('user_done'),
        Type.Literal('back_to_lesson'),
        Type.Literal('lesson_complete'),
      ],
      {
        description:
          'Machine-readable reason for ending the classroom session. Use user_done for satisfied/no-more-questions acknowledgments and back_to_lesson for resume-lesson requests.',
      },
    ),
  ),
});

type CloseSessionParams = Static<typeof CloseSessionParams>;

export function buildCloseSessionTool(opts: {
  closeSession: (data: { endReason?: string }) => Promise<boolean>;
  canCloseSession?: () => boolean;
  isUserCued?: () => boolean;
}): AgentTool<typeof CloseSessionParams> {
  return {
    name: 'close_session',
    label: 'Close session',
    description:
      'Explicitly close the classroom session after a clear ending, goodbye, or lesson wrap-up.',
    parameters: CloseSessionParams,
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: CloseSessionParams) => {
      if (opts.isUserCued?.()) {
        return {
          content: [
            {
              type: 'text',
              text: 'The user has already been invited to continue, so the session remains open.',
            },
          ],
          details: { emitted: false, skipped: true, reason: 'user_already_cued' },
        };
      }

      if (opts.canCloseSession && !opts.canCloseSession()) {
        return {
          content: [
            {
              type: 'text',
              text: 'Call a classroom agent for a short, visible closing line before closing the session.',
            },
          ],
          details: { emitted: false, skipped: true, reason: 'no_visible_agent_turn' },
        };
      }

      const emitted = await opts.closeSession({ endReason: params.endReason });
      return {
        content: [
          {
            type: 'text',
            text: emitted
              ? 'The classroom session has been marked for closure.'
              : 'The classroom session was already marked for closure.',
          },
        ],
        details: { emitted },
      };
    },
  };
}
