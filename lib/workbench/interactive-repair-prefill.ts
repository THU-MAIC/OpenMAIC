import type { WorkbenchTranslator } from '@/lib/i18n/workbench';

export const INTERACTIVE_REPAIR_ERROR_MAX = 512;
const INTERACTIVE_REPAIR_SCENE_ID_MAX = 128;

export interface WorkbenchComposerPrefill {
  readonly id: number;
  readonly text: string;
}

export function canApplyWorkbenchComposerPrefill(currentDraft: string): boolean {
  return currentDraft.trim().length === 0;
}

function cap(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function markdownFenceFor(value: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (const char of value) {
    if (char === '`') {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function normalizeSceneId(sceneId: string): string {
  return cap(sceneId.replace(/[\r\n\t]+/g, ' '), INTERACTIVE_REPAIR_SCENE_ID_MAX);
}

/**
 * Builds the user-visible repair draft. Product copy is localized; the
 * trust boundary is not: page-controlled error text is always bounded and
 * isolated in a fence that it cannot close itself.
 */
export function buildInteractiveRepairPrefill({
  sceneId,
  error,
  t,
}: {
  readonly sceneId: string;
  readonly error: string;
  readonly t: WorkbenchTranslator;
}): string {
  const safeSceneId = normalizeSceneId(sceneId);
  const evidence = cap(error, INTERACTIVE_REPAIR_ERROR_MAX);
  const fence = markdownFenceFor(evidence);

  return [
    t('workbench.interactiveRepair.request', { sceneId: safeSceneId }),
    t('workbench.interactiveRepair.instruction'),
    t('workbench.interactiveRepair.evidenceNotice'),
    `${t('workbench.interactiveRepair.evidenceLabel')}:`,
    `${fence}text\n${evidence}\n${fence}`,
  ].join('\n\n');
}
