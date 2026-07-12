import type { Stage, GeneratedAgentConfig } from '@/lib/types/stage';
import { createAgentConfig, type AgentRoster } from '@/lib/edit/agent-ops';

/**
 * Resolve the editable agent roster for a stage.
 *
 * Precedence:
 *  1. `stage.generatedAgentConfigs` is present and non-empty → return as-is.
 *  2. `stage.agentIds` is present → map each id through `resolvePreset(id)`,
 *     dropping ids that resolve to `undefined`.
 *  3. If the result so far is empty → return `[ createAgentConfig('teacher', 0, makeId()) ]`.
 *
 * The returned roster always contains ≥1 teacher. If step 2 yields configs
 * but none carry role 'teacher', a default teacher is prepended.
 */
export function materializeRoster(
  stage: Pick<Stage, 'agentIds' | 'generatedAgentConfigs'>,
  resolvePreset: (id: string) => GeneratedAgentConfig | undefined,
  makeId: () => string,
  isGlobalDefault: (id: string) => boolean = () => false,
): AgentRoster {
  // Step 1 — already materialized.
  // Deliberately returns the array as-is (by reference, no defensive copy) and does NOT
  // enforce the ≥1-teacher invariant: a stored roster is already maintained by the
  // editor's last-teacher guard, and callers rely on reference identity for change detection.
  if (stage.generatedAgentConfigs && stage.generatedAgentConfigs.length > 0) {
    return stage.generatedAgentConfigs;
  }

  // Step 2 — resolve preset ids. Global default presets get a fresh stage-scoped
  // id (prevents saveGeneratedAgents from overwriting built-in defaults on the
  // first edit). Stage-generated ids are kept as-is so existing scene references
  // (scene.multiAgent.agentIds) remain valid after a roster edit.
  let roster: AgentRoster = [];
  if (stage.agentIds && stage.agentIds.length > 0) {
    roster = stage.agentIds
      .map((id) => {
        const cfg = resolvePreset(id);
        if (!cfg) return undefined;
        return isGlobalDefault(id) ? { ...cfg, id: makeId() } : { ...cfg };
      })
      .filter((cfg): cfg is GeneratedAgentConfig => cfg !== undefined);
  }

  // Step 3 — fallback to a single default teacher when nothing was resolved
  if (roster.length === 0) {
    return [createAgentConfig('teacher', 0, makeId())];
  }

  // Guarantee ≥1 teacher — prepend a default teacher when none present.
  // Use roster.length as the palette index so avatar/color cycling continues correctly.
  const hasTeacher = roster.some((a) => a.role === 'teacher');
  if (!hasTeacher) {
    return [createAgentConfig('teacher', roster.length, makeId()), ...roster];
  }

  return roster;
}
