'use client';

/**
 * PBL v2 — Hero page.
 *
 * The Hero is the first thing the learner sees when they flip to the
 * PBL scene. It's deliberately light on information — title, short
 * description, the skills they will learn, the rough shape (stage /
 * task counts), and a single big "开始项目" call to action. Detail
 * (microtask list, hints, scripts) lives in the Workspace; opening
 * with all of that on screen would just intimidate.
 *
 * Clicking 开始项目 enters the Workspace immediately. The chat panel
 * then fires the GREETING phase of the Instructor (`/api/pbl/v2/open-task`)
 * so the opener streams in the place where the learner will read it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { useStageStore } from '@/lib/store/stage';
import { buildQuizSnapshot } from '@/lib/pbl/v2/operations/runtime/quiz-snapshot';
import { hasStartedProject, resetProjectProgress } from '@/lib/pbl/v2/operations/kernel/progress';
import { transitionProjectUiPhase } from '@/lib/pbl/v2/operations/kernel/runtime-events';
import {
  invalidatePendingWorkspaceLaunch,
  isCurrentWorkspaceLaunch,
  prepareCurrentWorkspaceLaunchProject,
} from '@/lib/pbl/v2/operations/runtime/workspace-launch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ProjectHero } from '../project-hero';

interface Props {
  readonly sceneId: string;
  readonly project: PBLProjectV2;
  readonly onProjectChange: (next: PBLProjectV2) => void;
  readonly onLaunchReady?: (next: PBLProjectV2) => void;
  /** True while a workspace stream started earlier is still in flight in the
   *  background (the learner stepped back to the Hero mid-stream). Reset is
   *  disabled while true: a late stream write would otherwise land on top of —
   *  and undo — the reset. */
  readonly instructorStreaming?: boolean;
}

export function PBLV2Hero({
  sceneId,
  project,
  onProjectChange,
  onLaunchReady,
  instructorStreaming = false,
}: Props) {
  const { locale } = useI18n();

  // Sync `project.language` (BCP-47 fallback locale) with the user's
  // UI locale from the top-right language switcher. This ONLY updates
  // the BCP-47 fallback — `project.languageDirective` (set by the
  // Planner from the classroom's content-language policy) is the
  // authoritative content-language source and is never overwritten
  // here. Runs once on mount per scene; cheap idempotent.
  useEffect(() => {
    if (!locale) return;
    if (project.language === locale) return;
    onProjectChange({ ...project, language: locale });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId, locale]);

  const instructorRole = useMemo(
    () => project.roles.find((r) => r.type === 'instructor'),
    [project.roles],
  );

  const microtaskCount = useMemo(
    () => project.milestones.reduce((acc, m) => acc + m.microtasks.length, 0),
    [project.milestones],
  );
  // SCENARIO ONLY. How many roleplay "acts" sit between prep and wrapup (≥1).
  const roleplayActCount = useMemo(
    () => project.milestones.filter((m) => m.scenarioStage === 'roleplay').length,
    [project.milestones],
  );

  const [launching, setLaunching] = useState(false);
  const launchEpochRef = useRef(0);
  const currentSceneIdRef = useRef(sceneId);
  const currentProjectRef = useRef(project);
  currentSceneIdRef.current = sceneId;
  currentProjectRef.current = project;
  useEffect(() => {
    invalidatePendingWorkspaceLaunch(launchEpochRef, setLaunching);
    return () => {
      launchEpochRef.current += 1;
    };
  }, [sceneId]);

  const handleStart = async () => {
    // Build a snapshot of the learner's prior-quiz results from
    // RuntimeStore so the server can fold quiz-accuracy into the
    // proficiency assessment before the Instructor's GREETING fires
    // from the Workspace chat.
    // Scenes from the same classroom that come BEFORE this PBL
    // contribute; anything after (or this scene itself) is ignored.
    //
    const epoch = ++launchEpochRef.current;
    const launchSceneId = sceneId;
    setLaunching(true);
    const allScenes = useStageStore.getState().scenes;
    const selfIdx = allScenes.findIndex((s) => s.id === sceneId);
    const priorScenes = selfIdx >= 0 ? allScenes.slice(0, selfIdx) : [];
    try {
      const priorQuizResults = await buildQuizSnapshot(priorScenes);
      if (!isCurrentWorkspaceLaunch(epoch, launchEpochRef, launchSceneId, currentSceneIdRef))
        return;
      const ready = prepareCurrentWorkspaceLaunchProject(currentProjectRef, priorQuizResults);
      if (onLaunchReady) onLaunchReady(ready);
      else onProjectChange(ready);
    } finally {
      if (epoch === launchEpochRef.current) setLaunching(false);
    }
  };

  // Resume an already-started project: no GREETING (that would duplicate
  // the opener and is unnecessary), just re-enter the workspace with all
  // progress intact. Reuse the launch path so the 1.3s reveal plays, same
  // as a first entry.
  const handleContinue = () => {
    const ready = transitionProjectUiPhase(project, 'workspace');
    if (onLaunchReady) onLaunchReady(ready);
    else onProjectChange(ready);
  };

  // Wipe progress back to a brand-new, never-played project. Stays on the
  // Hero (`uiPhase: 'hero'`); the button flips back to "Start project" and
  // the next launch replays the full first-time journey.
  const handleReset = () => {
    onProjectChange(resetProjectProgress(project));
  };

  const started = hasStartedProject(project);

  return (
    <ProjectHero
      details={{
        title: project.title,
        description: project.description,
        gains: project.gains,
        learningObjective: project.learningObjective,
        instructorName: instructorRole?.name ?? 'Instructor',
        milestoneCount: project.milestones.length,
        taskCount: microtaskCount,
        ...(project.scenario?.characters?.[0]
          ? {
              scenario: {
                characterName: project.scenario.characters[0].name,
                roleplayCount: roleplayActCount,
              },
            }
          : {}),
      }}
      started={started}
      launching={launching}
      instructorStreaming={instructorStreaming}
      onStart={() => void handleStart()}
      onContinue={handleContinue}
      onReset={handleReset}
    />
  );
}
