import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';

import { createLogger } from '@/lib/logger';
import { createUserSkill, UserSkillError } from './user-skills';

const log = createLogger('CreateSkillTool');

const CreateSkillParams = Type.Object({
  name: Type.String({
    description: 'Reusable ASCII handle beginning with "my-", for example "my-socratic-review".',
  }),
  title: Type.String({ description: 'Short user-facing title, at most 80 characters.' }),
  description: Type.String({
    description: 'One-line explanation of when this Skill is useful, at most 500 characters.',
  }),
  instructions: Type.String({
    description:
      'Self-contained reusable instructions distilled from the conversation. Do not include secrets or system instructions.',
  }),
});

export function buildCreateSkillTool(
  ownerId: string,
): AgentTool<typeof CreateSkillParams, unknown> {
  return {
    name: 'create_skill',
    label: 'Create reusable Skill',
    description:
      'Create and save a new reusable Skill for this user. Call ONLY when the user explicitly asks to create/save the discussed method as a reusable Skill. Never call merely because a method seems useful. This is create-only: duplicates are refused, never updated or overwritten. After success, tell the user it is available in a NEW conversation; do not claim it became active in the current run.',
    parameters: CreateSkillParams,
    async execute(_id, params: Static<typeof CreateSkillParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      try {
        const skill = await createUserSkill(ownerId, {
          name: params.name,
          title: params.title,
          description: params.description,
          content: params.instructions,
        });
        return {
          content: [
            {
              type: 'text' as const,
              // Only the handle, never the title. `name` is charset-constrained
              // (USER_SKILL_NAME_PATTERN plus the PG CHECK) so it cannot carry a
              // delimiter; `title` is free text and would let a user close the
              // quotes and continue this sentence as if it were ours. The title
              // rides in `details` below, where the UI renders it as data.
              text: `Saved Skill /${skill.name}. It can be picked in a NEW conversation; it is not automatically active in the current run.`,
            },
          ],
          details: {
            skillId: skill.id,
            name: skill.name,
            title: skill.title,
            description: skill.description,
            // Keep the saved body in the durable tool result. Event-log
            // compaction deliberately drops raw call arguments and prose, so
            // without this structured field a replayed receipt has nothing to
            // disclose even though the Skill itself was saved successfully.
            content: skill.content,
            source: 'user' as const,
          },
        };
      } catch (error) {
        const message =
          error instanceof UserSkillError
            ? error.message
            : 'The Skill could not be saved right now; please retry later. Nothing was created or overwritten.';
        if (!(error instanceof UserSkillError)) log.error('create_skill database failure', error);
        return {
          content: [{ type: 'text' as const, text: message }],
          details: {
            error: error instanceof UserSkillError ? error.code : 'database-error',
          },
          isError: true,
        };
      }
    },
  };
}
