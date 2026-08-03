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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Drama,
  GraduationCap,
  Layers,
  RotateCcw,
  Sparkles,
  Target,
} from 'lucide-react';

import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { useStageStore } from '@/lib/store/stage';
import { buildQuizSnapshot } from '@/lib/pbl/v2/operations/quiz-snapshot';
import { hasStartedProject, resetProjectProgress } from '@/lib/pbl/v2/operations/progress';
import { transitionProjectUiPhase } from '@/lib/pbl/v2/operations/runtime-events';
import {
  invalidatePendingWorkspaceLaunch,
  isCurrentWorkspaceLaunch,
  prepareCurrentWorkspaceLaunchProject,
} from '@/lib/pbl/v2/operations/workspace-launch';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { computeFitScale } from './fit-scale';

const LAUNCH_BUTTON_CLASS =
  'group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-primary py-4 text-base font-semibold text-primary-foreground shadow-[0_14px_34px_-12px_hsl(var(--primary)/0.7)] ring-1 ring-inset ring-white/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_20px_44px_-12px_hsl(var(--primary)/0.85)] disabled:translate-y-0 disabled:opacity-70';

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
  const { t, locale } = useI18n();

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

  // "What you'll gain" — the Planner's structured `gains` (3-5 readable,
  // project-specific competency statements: abilities / awareness /
  // knowledge built through the project). Fall back to the single
  // `learningObjective` sentence for legacy projects packaged before
  // `gains` existed; hide entirely when neither is set. We never
  // back-fill from task titles — that produced unreadable fragments
  // ("架构可行", "场景清晰") that aren't capabilities.
  const plannerGains = (project.gains ?? []).map((g) => g.trim()).filter(Boolean);
  const learningObjective = project.learningObjective?.trim() ?? '';
  const gains =
    plannerGains.length > 0 ? plannerGains : learningObjective ? [learningObjective] : [];

  // SCENARIO ONLY. `project.scenario` is the single gate for role-play
  // projects; normal projects leave it undefined and show only the
  // Instructor. We surface the primary in-scene character so the learner
  // sees, up front, who they'll be interacting with — distinct from the
  // Instructor mentor. The subtitle is a short fixed tagline (mirroring
  // the Instructor's), NOT the character's `situation`, which is too long
  // for the card and gets clipped. Display-only: never gates any logic.
  const scenarioCharacter = project.scenario?.characters?.[0];

  // Fit-to-box scaling. The Hero renders as flowed DOM inside the stage's
  // fixed 16:9 box (`overflow-hidden`, no scroll). At higher browser zoom the
  // box gets shorter than the card's natural height and the bottom (launch
  // button + hint) is clipped with no way to reach it — unlike a slide deck,
  // which stays fully visible by scaling to fit. Mirror that: measure the box
  // and the card and shrink the card uniformly when it would overflow. Layout
  // size (`offsetWidth/Height`) is unaffected by the transform, so observing
  // it can't feedback-loop with the scale we apply.
  const fitContainerRef = useRef<HTMLDivElement>(null);
  const fitContentRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);

  useLayoutEffect(() => {
    const container = fitContainerRef.current;
    const content = fitContentRef.current;
    if (!container || !content) return;
    const measure = () => {
      const next = computeFitScale({
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        contentWidth: content.offsetWidth,
        contentHeight: content.offsetHeight,
      });
      setFitScale((prev) => (Math.abs(prev - next) < 0.002 ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={fitContainerRef}
      className="relative h-full w-full overflow-hidden bg-gradient-to-br from-background via-background to-primary/[0.14]"
    >
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[linear-gradient(90deg,hsl(var(--foreground)/0.035)_1px,transparent_1px),linear-gradient(180deg,hsl(var(--foreground)/0.035)_1px,transparent_1px)] bg-[size:46px_46px] [mask-image:radial-gradient(ellipse_at_center,black_45%,transparent_92%)]" />
        <div className="absolute -left-[8%] -top-[14%] h-[66%] w-[52%] rounded-full bg-[radial-gradient(circle,hsl(var(--primary)/0.34),transparent_70%)] blur-3xl" />
        <div className="absolute -bottom-[18%] -right-[8%] h-[72%] w-[58%] rounded-full bg-[radial-gradient(circle,hsl(var(--primary)/0.30),transparent_72%)] blur-3xl" />
        <div className="absolute left-1/2 top-1/2 h-[80%] w-[66%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,hsl(var(--primary)/0.12),transparent_72%)] blur-2xl" />
      </div>

      {/* Centering layer: `items-center` (not the flex default `stretch`) so the
          card keeps its NATURAL height — otherwise it would be stretched to the
          box and `offsetHeight` would equal the container, defeating the fit
          measurement below. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          ref={fitContentRef}
          className="relative z-10 w-full max-w-3xl px-8 py-10"
          style={
            fitScale < 1
              ? { transform: `scale(${fitScale})`, transformOrigin: 'center center' }
              : undefined
          }
        >
          <div className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary shadow-sm shadow-primary/10">
            <Sparkles className="h-3.5 w-3.5" />
            {t('pbl.v2.hero.title')}
          </div>

          <h1 className="bg-gradient-to-br from-foreground via-foreground to-primary bg-clip-text pb-1 text-[2.6rem] font-extrabold leading-[1.12] tracking-tight text-transparent">
            {project.title}
          </h1>

          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
            {project.description}
          </p>

          {gains.length > 0 && (
            <div className="mt-6">
              <div className="mb-2.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <Target className="h-3 w-3" />
                {t('pbl.v2.hero.youWillLearn')}
              </div>
              <ul
                className={
                  gains.length > 1
                    ? 'grid grid-cols-1 gap-2 sm:grid-cols-2'
                    : 'grid grid-cols-1 gap-2'
                }
              >
                {gains.map((gain, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-inset ring-foreground/[0.07] transition-colors hover:bg-primary/[0.05] hover:ring-primary/20"
                  >
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="text-[13px] leading-snug text-foreground/90">{gain}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Stage / task counts + people. Narrow boxes use two columns to
              avoid grid min-width overflow; wider boxes keep the single-row
              layout that balances the Hero. */}
          <div
            className={
              scenarioCharacter
                ? // SCENARIO: replace the mechanical "stage / task" counts with
                  // the meaningful three-act flow card + the two people the
                  // learner works with (Instructor + role-play character).
                  'mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]'
                : 'mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]'
            }
          >
            {scenarioCharacter ? (
              <ScenarioFlowCard
                label={t('pbl.v2.hero.scenarioFlow')}
                prep={t('pbl.v2.sidebar.stagePrep')}
                roleplay={t('pbl.v2.sidebar.stageRoleplay')}
                wrapup={t('pbl.v2.sidebar.stageWrapup')}
                roleplayCount={roleplayActCount}
              />
            ) : (
              <>
                <StatCard
                  icon={<Layers className="h-4 w-4" />}
                  value={project.milestones.length}
                  label={t('pbl.v2.hero.stage')}
                />
                <StatCard
                  icon={<Target className="h-4 w-4" />}
                  value={microtaskCount}
                  label={t('pbl.v2.hero.task')}
                />
              </>
            )}
            <PersonCard
              icon={<GraduationCap className="h-4 w-4" />}
              role={t('pbl.v2.hero.tutor')}
              name={instructorRole?.name ?? 'Instructor'}
              intro={t('pbl.v2.hero.instructorTagline')}
              tone="instructor"
              className={scenarioCharacter ? undefined : 'col-span-2 sm:col-span-1'}
            />
            {scenarioCharacter && (
              <PersonCard
                icon={<Drama className="h-4 w-4" />}
                role={t('pbl.v2.hero.scenarioCharacter')}
                name={scenarioCharacter.name}
                intro={t('pbl.v2.hero.scenarioCharacterTagline')}
                tone="character"
              />
            )}
          </div>

          <div className="mt-7">
            {started ? (
              <div className="flex items-stretch gap-2">
                <button onClick={handleContinue} className={LAUNCH_BUTTON_CLASS}>
                  <span className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-[420%]" />
                  {t('pbl.v2.hero.continueProject')}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      disabled={instructorStreaming}
                      className="flex w-12 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-background/50 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background/50 disabled:hover:text-muted-foreground"
                      aria-label={t('pbl.v2.hero.resetProgress')}
                      title={t('pbl.v2.hero.resetProgress')}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('pbl.v2.hero.resetConfirmTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('pbl.v2.hero.resetConfirmDescription')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('pbl.v2.hero.resetConfirmCancel')}</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={handleReset}>
                        {t('pbl.v2.hero.resetConfirmConfirm')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : (
              <button
                onClick={() => void handleStart()}
                disabled={launching}
                className={LAUNCH_BUTTON_CLASS}
              >
                <span className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-[420%]" />
                {t('pbl.v2.hero.startProject')}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            )}
            <p className="text-xs text-muted-foreground text-center mt-3">
              {t('pbl.v2.hero.startHint', { name: instructorRole?.name ?? 'Instructor' })}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

const META_CARD_BASE =
  'flex min-w-0 flex-col gap-1.5 rounded-2xl px-3.5 py-2.5 ring-1 ring-inset transition-colors';

/** Numeric count tile (stage / task) — icon + label on top, the big
 *  number anchored to the bottom so all cards in the row share a
 *  baseline. */
function StatCard({
  icon,
  value,
  label,
}: {
  readonly icon: React.ReactNode;
  readonly value: string | number;
  readonly label: string;
}) {
  return (
    <div
      className={`${META_CARD_BASE} bg-foreground/[0.03] ring-foreground/[0.07] hover:bg-primary/[0.05] hover:ring-primary/25`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-inset ring-primary/15">
          {icon}
        </span>
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="text-[1.6rem] font-bold leading-none tracking-tight text-foreground">
        {value}
      </div>
    </div>
  );
}

/** A "who you'll work with" card, sharing the StatCard footprint so the
 *  whole row aligns. `instructor` tone is the always-present mentor;
 *  `character` tone (amber, theatre-mask icon) is the SCENARIO-ONLY
 *  role-play character, deliberately styled apart so the learner can tell
 *  them from the mentor at a glance. */
function PersonCard({
  icon,
  role,
  name,
  intro,
  tone,
  className,
}: {
  readonly icon: React.ReactNode;
  readonly role: string;
  readonly name: string;
  readonly intro: string;
  readonly tone: 'instructor' | 'character';
  readonly className?: string;
}) {
  const isCharacter = tone === 'character';
  return (
    <div
      className={`${META_CARD_BASE} ${
        isCharacter
          ? 'bg-amber-500/[0.06] ring-amber-500/20 hover:bg-amber-500/[0.1] hover:ring-amber-500/35'
          : 'bg-foreground/[0.03] ring-foreground/[0.07] hover:bg-primary/[0.05] hover:ring-primary/25'
      } ${className ?? ''}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={
            isCharacter
              ? 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300'
              : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-inset ring-primary/15'
          }
        >
          {icon}
        </span>
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {role}
        </span>
      </div>
      <div>
        <div className="truncate text-[15px] font-bold leading-tight tracking-tight text-foreground">
          {name}
        </div>
        <div className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-muted-foreground">
          {intro}
        </div>
      </div>
    </div>
  );
}

/** SCENARIO ONLY. Replaces the "stage / task" count tiles with a meaningful
 *  shape of the run: the fixed three acts (prep → roleplay → wrapup). When the
 *  middle has more than one roleplay act we show the count (e.g. "模拟 ×2");
 *  beats stay hidden. Shares the meta-card footprint so the row aligns. */
function ScenarioFlowCard({
  label,
  prep,
  roleplay,
  wrapup,
  roleplayCount,
}: {
  readonly label: string;
  readonly prep: string;
  readonly roleplay: string;
  readonly wrapup: string;
  readonly roleplayCount: number;
}) {
  const mid = roleplayCount > 1 ? `${roleplay} ×${roleplayCount}` : roleplay;
  return (
    <div
      className={`${META_CARD_BASE} bg-foreground/[0.03] ring-foreground/[0.07] hover:bg-primary/[0.05] hover:ring-primary/25`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-inset ring-primary/15">
          <Layers className="h-4 w-4" />
        </span>
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight tracking-tight text-foreground">
        <span>{prep}</span>
        <span className="text-muted-foreground/60">›</span>
        <span className="text-primary">{mid}</span>
        <span className="text-muted-foreground/60">›</span>
        <span>{wrapup}</span>
      </div>
    </div>
  );
}
