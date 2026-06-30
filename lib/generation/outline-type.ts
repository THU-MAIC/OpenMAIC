import type { SceneOutline, WidgetOutline } from '@/lib/types/generation';

type SceneType = SceneOutline['type'];

const DEFAULT_QUIZ_CONFIG = {
  questionCount: 3,
  difficulty: 'medium' as const,
  questionTypes: ['single' as const],
};
const MAX_TARGET_SKILLS = 6;

/**
 * Total constructor: returns a NEW outline of `newType` that is valid by
 * construction. It strips every foreign per-type config and seeds the target
 * type's required config from the shared fields (title / description /
 * keyPoints), so the result survives `applyOutlineFallbacks` instead of being
 * silently downgraded to a slide.
 *
 * Seeded values are pre-filled, user-editable defaults — not a hidden
 * generation-time fallback. Switching away from a type therefore also clears
 * its config so stale data is never persisted.
 */
export function changeOutlineType(outline: SceneOutline, newType: SceneType): SceneOutline {
  // Re-selecting the current type is a no-op: return the outline untouched so a
  // harmless menu click never rebuilds it and drops fields this constructor does
  // not re-seed (e.g. legacy interactiveConfig, or a partial pblConfig whose
  // projectTopic happens to be empty).
  if (newType === outline.type) {
    return outline;
  }

  // Shared fields only — every per-type config is intentionally dropped here and
  // re-seeded per branch below.
  const baseOutline: SceneOutline = {
    id: outline.id,
    type: newType,
    title: outline.title,
    description: outline.description,
    keyPoints: outline.keyPoints ?? [],
    order: outline.order,
    ...(outline.teachingObjective !== undefined && {
      teachingObjective: outline.teachingObjective,
    }),
    ...(outline.estimatedDuration !== undefined && {
      estimatedDuration: outline.estimatedDuration,
    }),
    ...(outline.languageNote !== undefined && { languageNote: outline.languageNote }),
    ...(outline.suggestedImageIds !== undefined && {
      suggestedImageIds: outline.suggestedImageIds,
    }),
    ...(outline.mediaGenerations !== undefined && { mediaGenerations: outline.mediaGenerations }),
  };

  switch (newType) {
    case 'quiz':
      return { ...baseOutline, quizConfig: outline.quizConfig ?? { ...DEFAULT_QUIZ_CONFIG } };

    case 'interactive': {
      // Preserve any already-valid widget config — including a gated
      // procedural-skill one, whose task-engine fields must not be silently
      // dropped when the type is re-selected. Otherwise seed a simulation widget.
      // (The manual widget picker never *creates* procedural-skill.)
      if (outline.widgetType && outline.widgetOutline) {
        return {
          ...baseOutline,
          widgetType: outline.widgetType,
          widgetOutline: outline.widgetOutline,
        };
      }
      const widgetOutline: WidgetOutline = { concept: outline.title || '' };
      return { ...baseOutline, widgetType: 'simulation', widgetOutline };
    }

    case 'pbl': {
      if (outline.pblConfig?.projectTopic) {
        return { ...baseOutline, pblConfig: outline.pblConfig };
      }
      const targetSkills = Array.from(new Set((outline.keyPoints ?? []).filter(Boolean))).slice(
        0,
        MAX_TARGET_SKILLS,
      );
      return {
        ...baseOutline,
        pblConfig: {
          projectTopic: outline.title || '',
          projectDescription: outline.description || '',
          targetSkills,
        },
      };
    }

    case 'slide':
    default:
      return baseOutline;
  }
}
