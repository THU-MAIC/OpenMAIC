import type {
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  GeneratedQuizContent,
  GeneratedSlideContent,
} from '@/lib/types/generation';
import type { SceneContent } from '@/lib/types/stage';
import { normalizeLegacyPBLContent } from '@/lib/pbl/legacy/read';

/**
 * Adapt persisted runtime content to the generation-time content shapes used
 * by action generation. Slides are the only structural mismatch: their
 * elements live under `canvas` at runtime but at the top level while
 * generating. Legacy PBL documents are normalized at the same boundary.
 */
export function toGenerationContent(
  content: SceneContent,
):
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent {
  if (content.type === 'slide') {
    return {
      elements: content.canvas.elements ?? [],
      background: content.canvas.background,
    } satisfies GeneratedSlideContent;
  }
  if (content.type === 'pbl') {
    return normalizeLegacyPBLContent(content) as GeneratedPBLContent;
  }
  return content as GeneratedQuizContent | GeneratedInteractiveContent;
}
