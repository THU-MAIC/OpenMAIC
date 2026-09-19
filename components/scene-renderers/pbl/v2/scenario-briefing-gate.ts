/**
 * PBL v2 — Scenario briefing visibility gate (SCENARIO ONLY).
 *
 * Single source of truth for "should the right column show the scenario
 * briefing tab?". Kept as a tiny, dependency-free pure function (no React, no
 * UI imports) so it is trivially unit-testable and cannot drift between the
 * component and its tests.
 *
 * The briefing tab appears once the learner has ENTERED the scenario — i.e. the
 * fixed first `prep` milestone is completed. `prep` only ever transitions to
 * `completed` (never back), so this stays true for the rest of the run: through
 * every roleplay stage, the wrapup, and after returning from the completion
 * page (no active milestone). Non-scenario projects (no `project.scenario`) and
 * scenario projects still in prep return false, so the workspace renders the
 * bare submission panel exactly as before — zero footprint on those paths.
 */

import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

export function shouldShowScenarioBriefing(project: PBLProjectV2): boolean {
  if (!project.scenario) return false;
  return project.milestones.some((m) => m.scenarioStage === 'prep' && m.status === 'completed');
}
