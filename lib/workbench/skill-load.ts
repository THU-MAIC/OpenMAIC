/**
 * What a "skill load" looks like on the timeline — ONE definition.
 *
 * Loading a skill is a `read` of that skill's `SKILL.md`. Two places need to
 * recognise it and they must not drift: the fold, which draws the card from the
 * durable message frames (`lib/workbench/session-store`), and the presentation
 * layer, which labels it "load skill" and groups the cards
 * (`components/workbench/chat/tool-presentation`).
 *
 * It lives in its own module rather than in the presentation layer because the
 * fold cannot import that one — it pulls in lucide icons and the workbench
 * translator, which have no business inside a pure reducer. Kept dependency-free
 * so both sides can hold the same rule.
 */

/** The minimum a caller must know about a tool card for these questions. */
export interface SkillLoadProbe {
  toolName?: string | undefined;
  toolArgs?: Record<string, unknown> | undefined;
}

/** Pi loads a skill by `read`-ing that skill's SKILL.md. */
const SKILL_MD_PATH = /(?:^|\/)([^/]+)\/SKILL\.md$/i;

/** The skill's directory name when this call is a skill load, else undefined. */
export function skillLoadId(node: SkillLoadProbe): string | undefined {
  if (node.toolName !== 'read') return undefined;
  const path = typeof node.toolArgs?.path === 'string' ? node.toolArgs.path.trim() : '';
  const match = path.match(SKILL_MD_PATH);
  return match?.[1];
}

export function isSkillLoadTool(node: SkillLoadProbe): boolean {
  return skillLoadId(node) !== undefined;
}
