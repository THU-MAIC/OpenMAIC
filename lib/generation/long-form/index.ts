/**
 * Long-form planning: the 25-minute-and-up path.
 *
 * Three layers, each pure and independently testable:
 *
 *   budget.ts  — the operating numbers (speech rate, density, duration parsing)
 *   plan.ts    — duration → modules → pages, with minutes and speech budgets
 *   brief.ts   — plan → the text the outline and narration prompts receive
 *
 * Nothing here calls a model, reads config or touches storage. Callers detect
 * long form with `detectLongForm(requirement)`, plan with
 * `planLongFormCourse(...)`, and hand `buildLongFormBrief` / `buildSceneBrief`
 * to whichever prompt they are building.
 */

export {
  CHECKPOINT_MODULE_MINUTES,
  DEFAULT_SCENE_DENSITY,
  LONG_FORM_MAX_MINUTES,
  LONG_FORM_MIN_MINUTES,
  MAX_MODULE_MINUTES,
  MAX_SCENE_SECONDS,
  MIN_MODULE_MINUTES,
  MIN_SCENE_SECONDS,
  SPEECH_DENSITY,
  SPEECH_RATE_PER_MINUTE,
  apportion,
  clampMinutes,
  detectLongForm,
  detectRequestedMinutes,
  speechBudgetFor,
  speechRateFor,
} from './budget';

export {
  enforceBounds,
  formatClock,
  functionsFor,
  locateScene,
  moduleCountFor,
  planLongFormCourse,
} from './plan';

export { auditNarration, narrationIsClean } from './narration-audit';
export type { NarrationAudit, NarrationCode, NarrationDefect } from './narration-audit';
export { buildLongFormBrief, buildSceneBrief, moduleAtPage, speechUnit } from './brief';
export type { ScenePositionInput } from './brief';

export {
  auditIsClean,
  auditOutline,
  auditSeverity,
  newStructuralDefects,
  pageCeilingFor,
  pageFloorFor,
  prioritizeDefects,
} from './audit';
export type { AuditCode, AuditDefect, AuditOptions, OutlineAudit } from './audit';

export { buildLedgerText } from './ledger';
export type { LedgerOptions } from './ledger';

export { inferPlanLanguage, planForRequirement } from './requirement';

export {
  CRITIQUE_DIMENSIONS,
  CRITIQUE_MIN_MS,
  CRITIQUE_PASS_SCORE,
  DIMENSION_LABEL,
  AUDIT_DEFECT_BUDGET,
  MAX_DEFECTS,
  MAX_REVISION_DRIFT,
  MAX_REVISION_ROUNDS,
  REVISE_MIN_MS,
  applyRevisionPatch,
  critiquePasses,
  defectPages,
  extractJsonObject,
  formatCritiqueForRevision,
  hasTimeFor,
  isSafeRevision,
  mergeAuditIntoCritique,
  parseCritique,
  parseRevisionPatch,
  repairWorsens,
  serializeOutlineForCritic,
  shouldRevise,
} from './revision';
export type {
  Critique,
  CritiqueDefect,
  CritiqueDimension,
  RevisionPatch,
  RevisionSafety,
} from './revision';

export type {
  LongFormCoursePlan,
  LongFormLanguage,
  LongFormModulePlan,
  LongFormPlanOptions,
  LongFormSceneSlot,
  SceneRole,
  TeachingFunction,
} from './types';
