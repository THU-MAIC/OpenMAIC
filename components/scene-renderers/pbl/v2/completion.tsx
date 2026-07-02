'use client';

/**
 * PBL v2 — Completion report.
 *
 * Shown after the learner clicks the chat CTA once the final evaluator
 * has finished. The report combines:
 *   1. LLM-produced final evaluation (whatYouBuilt / whatYouLearned /
 *      whatsNext / stars) — the global summary.
 *   2. Deterministic stats derived from microtask engagement caches
 *      (concepts unlocked, independence rate, error recovery) — the
 *      data-driven stage-by-stage view.
 *
 * The two sources are complementary: the LLM gives narrative, the
 * caches give verifiable facts that never hallucinate.
 */

import {
  ArrowLeft,
  Award,
  Check,
  Clock,
  Compass,
  Contrast,
  Hammer,
  Layers,
  Lightbulb,
  MessageCircle,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  Trophy,
  X,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { PBLEvaluation, PBLProjectV2, PBLScenarioActGoals } from '@/lib/pbl/v2/types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { stripEvaluationTail } from '@/lib/pbl/v2/operations/eval-tail-parser';
import {
  computeCompletionStats,
  type CompletionStats,
  type StandardCompletionStats,
  type ScenarioCompletionStats,
  type ScenarioActGoalScaffold,
  type StageDetail,
} from '@/lib/pbl/v2/operations/completion-stats';

interface Props {
  readonly project: PBLProjectV2;
  readonly onBack?: () => void;
}

export interface CompletionReportViewModel {
  readonly totalMicrotasks: number;
  readonly completedMicrotasks: number;
  readonly stageCount: number;
  readonly finalEvaluation?: PBLEvaluation;
  readonly intro?: string;
  readonly whatYouBuilt: string[];
  readonly whatYouLearned: string[];
  readonly whatsNext?: string;
  readonly stars?: number;
  readonly stats: CompletionStats;
}

function formatDuration(totalSeconds: number, t: ReturnType<typeof useI18n>['t']): string {
  if (totalSeconds <= 0) return '—';
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return t('pbl.v2.completion.durationMinutes', { m });
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0
    ? t('pbl.v2.completion.durationHoursMinutes', { h, m: rm })
    : t('pbl.v2.completion.durationHours', { h });
}

export function buildCompletionReportViewModel(project: PBLProjectV2): CompletionReportViewModel {
  const totalMicrotasks = project.milestones.reduce((acc, m) => acc + m.microtasks.length, 0);
  const completedMicrotasks = project.milestones.reduce(
    (acc, m) => acc + m.microtasks.filter((t) => t.status === 'completed').length,
    0,
  );
  const finalEvaluation = project.evaluations.filter((ev) => ev.kind === 'final').at(-1);
  return {
    totalMicrotasks,
    completedMicrotasks,
    stageCount: project.milestones.length,
    finalEvaluation,
    intro: cleanCompletionIntro(finalEvaluation?.feedback),
    whatYouBuilt: finalEvaluation?.whatYouBuilt ?? [],
    whatYouLearned: finalEvaluation?.whatYouLearned ?? [],
    whatsNext: finalEvaluation?.whatsNext,
    stars: finalEvaluation?.stars,
    stats: computeCompletionStats(project),
  };
}

export function cleanCompletionIntro(feedback: string | undefined): string | undefined {
  const intro = stripEvaluationTail(feedback ?? '')
    .replace(/\{\{\s*[^}]+\s*\}\}/g, '')
    .trim();
  return intro || undefined;
}

export function PBLV2Completion({ project, onBack }: Props) {
  const { t } = useI18n();
  const report = buildCompletionReportViewModel(project);
  const { stats } = report;

  // Shared shell (celebration, hero, stars, what's-next) is identical for both
  // project kinds; the BODY between hero and what's-next is fully split by
  // `stats.kind` into two components that share NO fields — the discriminated
  // union makes it impossible for one to read the other's metrics.
  const heroCaption = stats.kind === 'scenario' ? stats.sceneCaption : undefined;
  const heroSummary =
    report.intro ??
    (stats.kind === 'scenario'
      ? t('pbl.v2.completion.scenario.summary', {
          acts: stats.acts.total,
        })
      : t('pbl.v2.completion.summary', {
          completed: report.completedMicrotasks,
          total: report.totalMicrotasks,
          stages: report.stageCount,
        }));

  return (
    <div className="relative h-full w-full overflow-y-auto bg-[radial-gradient(circle_at_20%_10%,rgba(124,92,255,0.18),transparent_32%),radial-gradient(circle_at_88%_0%,rgba(34,211,238,0.14),transparent_30%),linear-gradient(135deg,#0b1220_0%,#111c33_52%,#0a1020_100%)] text-slate-100">
      <div className="m-auto w-full max-w-6xl px-8 py-10">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-4 inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/[0.08]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('pbl.v2.completion.backToWorkspace')}
          </button>
        )}

        {/* ── Celebration ── */}
        <CelebrationHeader />

        {/* ── Hero banner ── */}
        <section className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.045] p-7 shadow-[0_12px_40px_rgba(0,0,0,0.20)] backdrop-blur-xl">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wider text-cyan-200/90">
            <span className="inline-flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-300" />
              {t('pbl.v2.completion.title')}
            </span>
          </div>
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white">{project.title}</h1>
              {heroCaption && (
                <p className="mt-2 text-sm font-medium text-cyan-200/80">{heroCaption}</p>
              )}
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300/90">
                {heroSummary}
              </p>
            </div>
            {typeof report.stars === 'number' && (
              <div className="shrink-0 rounded-2xl border border-amber-200/15 bg-amber-300/[0.08] px-4 py-3 text-right">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-amber-200/90">
                  Stars
                </div>
                <div className="flex items-center gap-1 text-amber-300">
                  <Star className="h-4 w-4 fill-current" />
                  <span className="text-2xl font-bold text-white">{report.stars}</span>
                  <span className="text-sm text-amber-100/80">/ 5</span>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── Body (split by project kind — no shared fields) ── */}
        {stats.kind === 'scenario' ? (
          <ScenarioCompletionBody stats={stats} report={report} />
        ) : (
          <StandardCompletionBody stats={stats} report={report} />
        )}

        {/* ── What's next ── */}
        <section className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Compass className="h-4 w-4 text-cyan-300" />
            {t('pbl.v2.completion.whatsNext')}
          </div>
          <p className="text-sm leading-relaxed text-slate-300">
            {report.whatsNext ?? t('pbl.v2.completion.noWhatsNext')}
          </p>
        </section>
      </div>
    </div>
  );
}

/** Knowledge-project body: stat cards + built/learned + stage review +
 *  highlights. This is the ORIGINAL completion content, moved verbatim — normal
 *  projects render byte-identically to before the scenario split. */
function StandardCompletionBody({
  stats,
  report,
}: {
  readonly stats: StandardCompletionStats;
  readonly report: CompletionReportViewModel;
}) {
  const { t } = useI18n();
  return (
    <>
      {/* ── Stats cards ── */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={<Lightbulb className="h-4 w-4" />}
          label={t('pbl.v2.completion.statConcepts')}
          value={String(stats.conceptsUnlocked.length)}
        />
        <StatCard
          icon={<MessageCircle className="h-4 w-4" />}
          label={t('pbl.v2.completion.statTurns')}
          value={String(stats.totalTurns)}
        />
        <StatCard
          icon={<Layers className="h-4 w-4" />}
          label={t('pbl.v2.completion.statScope')}
          value={`${report.stageCount} · ${report.totalMicrotasks}`}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label={t('pbl.v2.completion.statDuration')}
          value={formatDuration(stats.totalDurationSeconds, t)}
        />
        <StatCard
          icon={<Hammer className="h-4 w-4" />}
          label={t('pbl.v2.completion.statSubmissions')}
          value={String(stats.totalSubmissions)}
        />
      </div>

      {/* ── LLM global summary ── */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ReportSection
          icon={<Hammer className="h-4 w-4" />}
          title={t('pbl.v2.completion.whatYouBuilt')}
          items={report.whatYouBuilt}
          fallback={t('pbl.v2.completion.noDataFallback')}
        />
        <ReportSection
          icon={<Sparkles className="h-4 w-4" />}
          title={t('pbl.v2.completion.whatYouLearned')}
          items={report.whatYouLearned}
          fallback={t('pbl.v2.completion.noDataFallback')}
        />
      </div>

      {/* ── Stage review ── */}
      {stats.stageDetails.length > 0 && (
        <section className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100">
            <ShieldCheck className="h-4 w-4 text-cyan-300" />
            {t('pbl.v2.completion.stageReview')}
          </div>
          <ol className="grid gap-3 md:grid-cols-2">
            {stats.stageDetails.map((sd, idx) => (
              <StageReviewItem key={`${idx}-${sd.milestoneTitle}`} detail={sd} index={idx} />
            ))}
          </ol>
        </section>
      )}

      {stats.highlights.length > 0 && (
        <section className="mt-4 rounded-2xl border border-amber-200/15 bg-amber-300/[0.05] p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-100">
            <Award className="h-4 w-4 text-amber-300" />
            {t('pbl.v2.completion.highlightsTitle')}
          </div>
          <ul className="space-y-2">
            {stats.highlights.map((h, idx) => (
              <li key={idx} className="text-sm leading-relaxed text-slate-200">
                {formatHighlight(h, t)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** SCENARIO body: skill-practice stat cards + what-you-did-well / skills +
 *  per-act goal review (the externalised hidden goals, judged by the final
 *  evaluator) + cast. Shows NO knowledge metrics. */
function ScenarioCompletionBody({
  stats,
  report,
}: {
  readonly stats: ScenarioCompletionStats;
  readonly report: CompletionReportViewModel;
}) {
  const { t } = useI18n();
  const cov = stats.goalCoverage;
  return (
    <>
      {/* ── Stat cards ── */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {cov && (
          <StatCard
            icon={<Target className="h-4 w-4" />}
            label={t('pbl.v2.completion.scenario.statGoals')}
            value={`${cov.achieved}/${cov.total}`}
          />
        )}
        <StatCard
          icon={<Layers className="h-4 w-4" />}
          label={t('pbl.v2.completion.scenario.statActs')}
          value={String(stats.acts.total)}
        />
        <StatCard
          icon={<MessageCircle className="h-4 w-4" />}
          label={t('pbl.v2.completion.statTurns')}
          value={String(stats.totalTurns)}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label={t('pbl.v2.completion.statDuration')}
          value={formatDuration(stats.totalDurationSeconds, t)}
        />
      </div>

      {/* ── LLM skill summary ── */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ReportSection
          icon={<Hammer className="h-4 w-4" />}
          title={t('pbl.v2.completion.scenario.whatYouDidWell')}
          items={report.whatYouBuilt}
          fallback={t('pbl.v2.completion.noDataFallback')}
        />
        <ReportSection
          icon={<Sparkles className="h-4 w-4" />}
          title={t('pbl.v2.completion.scenario.skillsPracticed')}
          items={report.whatYouLearned}
          fallback={t('pbl.v2.completion.noDataFallback')}
        />
      </div>

      {/* ── Per-act goal review (externalised hidden goals) ── */}
      {cov && (
        <section className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Target className="h-4 w-4 text-cyan-300" />
            {t('pbl.v2.completion.scenario.goalReviewTitle')}
          </div>
          <p className="mb-4 text-xs leading-relaxed text-slate-400">
            {t('pbl.v2.completion.scenario.goalReviewHint', {
              achieved: cov.achieved,
              total: cov.total,
            })}
          </p>
          <ol className="grid gap-3 md:grid-cols-2">
            {cov.acts.map((act, idx) => (
              <ActGoalReviewItem key={`${idx}-${act.milestoneId}`} act={act} index={idx} />
            ))}
          </ol>
        </section>
      )}

      {/* ── Per-act goal list (FALLBACK, no verdict) ──
          Shown only when there is no scored `goalCoverage` — chiefly older
          projects finished before the act-goals evaluator shipped. Renders the
          authored "what each act asked you to do" read-only, so the structured
          review survives instead of dropping to a bare narrative. Mutually
          exclusive with the scored review above. */}
      {!cov && stats.goalScaffold && stats.goalScaffold.length > 0 && (
        <section className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Target className="h-4 w-4 text-cyan-300" />
            {t('pbl.v2.completion.scenario.goalListTitle')}
          </div>
          <p className="mb-4 text-xs leading-relaxed text-slate-400">
            {t('pbl.v2.completion.scenario.goalListHint')}
          </p>
          <ol className="grid gap-3 md:grid-cols-2">
            {stats.goalScaffold.map((act, idx) => (
              <ActGoalListItem key={`${idx}-${act.milestoneId}`} act={act} index={idx} />
            ))}
          </ol>
        </section>
      )}

      {/* ── Cast ── */}
      {stats.characterNames.length > 0 && (
        <p className="mt-3 px-1 text-xs text-slate-400">
          {t('pbl.v2.completion.scenario.castLabel', {
            names: stats.characterNames.join('、'),
          })}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// Deterministic confetti layout (no Math.random at render → no hydration
// mismatch). Each piece falls + drifts + spins on an infinite loop.
const CONFETTI: ReadonlyArray<{
  left: number;
  color: string;
  size: number;
  delay: number;
  duration: number;
  drift: number;
  rotate: number;
}> = [
  { left: 6, color: '#a78bfa', size: 6, delay: 0.0, duration: 3.0, drift: 14, rotate: 320 },
  { left: 14, color: '#67e8f9', size: 7, delay: 0.7, duration: 3.4, drift: -10, rotate: -260 },
  { left: 22, color: '#fcd34d', size: 5, delay: 1.3, duration: 2.8, drift: 8, rotate: 400 },
  { left: 30, color: '#6ee7b7', size: 6, delay: 0.4, duration: 3.2, drift: -16, rotate: -340 },
  { left: 38, color: '#f9a8d4', size: 7, delay: 1.0, duration: 3.6, drift: 12, rotate: 300 },
  { left: 46, color: '#7dd3fc', size: 5, delay: 0.2, duration: 2.9, drift: -8, rotate: -380 },
  { left: 54, color: '#a78bfa', size: 6, delay: 1.5, duration: 3.3, drift: 16, rotate: 360 },
  { left: 62, color: '#fcd34d', size: 7, delay: 0.6, duration: 3.0, drift: -12, rotate: -300 },
  { left: 70, color: '#6ee7b7', size: 5, delay: 1.1, duration: 3.5, drift: 10, rotate: 420 },
  { left: 78, color: '#67e8f9', size: 6, delay: 0.3, duration: 2.7, drift: -14, rotate: -340 },
  { left: 86, color: '#f9a8d4', size: 7, delay: 0.9, duration: 3.4, drift: 8, rotate: 320 },
  { left: 94, color: '#a78bfa', size: 5, delay: 1.4, duration: 3.1, drift: -10, rotate: -360 },
  { left: 18, color: '#fcd34d', size: 6, delay: 1.8, duration: 3.2, drift: 12, rotate: 380 },
  { left: 82, color: '#7dd3fc', size: 6, delay: 2.0, duration: 3.3, drift: -8, rotate: -320 },
];

function CelebrationHeader() {
  return (
    <div className="pointer-events-none relative mx-auto mb-2 flex h-24 w-full max-w-md items-center justify-center">
      {CONFETTI.map((c, i) => (
        <motion.span
          key={i}
          className="absolute top-0 block rounded-[2px]"
          style={{
            left: `${c.left}%`,
            width: c.size,
            height: c.size * 1.6,
            backgroundColor: c.color,
          }}
          initial={{ y: -12, x: 0, opacity: 0, rotate: 0 }}
          animate={{ y: [-12, 108], x: [0, c.drift], opacity: [0, 1, 1, 0], rotate: [0, c.rotate] }}
          transition={{
            duration: c.duration,
            delay: c.delay,
            repeat: Infinity,
            repeatDelay: 0.5,
            ease: 'easeIn',
          }}
        />
      ))}
      <motion.div
        className="relative z-10 select-none text-5xl drop-shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
        initial={{ scale: 0.5, rotate: -12, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 220, damping: 12, delay: 0.1 }}
      >
        <motion.span
          className="inline-block"
          animate={{ y: [0, -6, 0], rotate: [0, 6, -4, 0] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          🎉
        </motion.span>
      </motion.div>
    </div>
  );
}

function formatHighlight(
  h: StandardCompletionStats['highlights'][number],
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (h.kind) {
    case 'independence':
      return t('pbl.v2.completion.highlight.independence', {
        unlocks: h.unlocks ?? 0,
        total: h.total ?? 0,
      });
    case 'resilience':
      return h.milestoneTitle
        ? t('pbl.v2.completion.highlight.resilience', {
            title: h.milestoneTitle,
            errors: h.errors ?? 0,
          })
        : t('pbl.v2.completion.highlight.resilienceGeneral', {
            errors: h.errors ?? 0,
          });
    case 'completion':
    default:
      return t('pbl.v2.completion.highlight.completion');
  }
}

function StatCard({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.035] px-4 py-3.5 text-center transition-colors hover:bg-white/[0.055]">
      <div className="mb-1.5 inline-flex items-center justify-center rounded-lg bg-white/[0.06] p-1.5 text-cyan-300/90">
        {icon}
      </div>
      <div className="text-xl font-bold text-white">{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-400">{label}</div>
    </div>
  );
}

/** SCENARIO ONLY. One act's goal-coverage card: the act title + each
 *  externalised goal with a three-state status icon, its skill label, and the
 *  evaluator's note. The goals were hidden checkpoints during play; here they
 *  are revealed read-only as "what this act was about". */
function ActGoalReviewItem({
  act,
  index,
}: {
  readonly act: PBLScenarioActGoals;
  readonly index: number;
}) {
  return (
    <li className="rounded-xl border border-white/[0.05] bg-white/[0.03] px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-cyan-100/[0.10] text-[11px] font-bold text-cyan-200/80">
          {index + 1}
        </span>
        <span className="text-sm font-medium text-slate-100">{act.actTitle}</span>
      </div>
      <ul className="mt-2.5 ml-1 space-y-2">
        {act.goals.map((g, gi) => (
          <li key={gi} className="flex gap-2 text-xs leading-relaxed">
            <GoalStatusIcon status={g.status} />
            <div className="min-w-0 flex-1">
              <span className="text-slate-200">{g.goal}</span>
              {g.skillFocus && (
                <span className="ml-1.5 inline-block rounded bg-violet-300/[0.10] px-1.5 py-0.5 text-[10px] text-violet-200">
                  {g.skillFocus}
                </span>
              )}
              {g.note && <p className="mt-0.5 text-[11px] text-slate-400">{g.note}</p>}
            </div>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** FALLBACK list item: the authored act + its goals, READ-ONLY (no verdict).
 *  Used when there is no scored `goalCoverage` (older projects). Mirrors
 *  `ActGoalReviewItem`'s layout but drops the status icon + note. */
function ActGoalListItem({
  act,
  index,
}: {
  readonly act: ScenarioActGoalScaffold;
  readonly index: number;
}) {
  return (
    <li className="rounded-xl border border-white/[0.05] bg-white/[0.03] px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-cyan-100/[0.10] text-[11px] font-bold text-cyan-200/80">
          {index + 1}
        </span>
        <span className="text-sm font-medium text-slate-100">{act.actTitle}</span>
      </div>
      <ul className="mt-2.5 ml-1 space-y-2">
        {act.goals.map((g, gi) => (
          <li key={gi} className="flex gap-2 text-xs leading-relaxed">
            <span className="mt-0.5 text-slate-500" aria-hidden>
              •
            </span>
            <div className="min-w-0 flex-1">
              <span className="text-slate-200">{g.goal}</span>
              {g.skillFocus && (
                <span className="ml-1.5 inline-block rounded bg-violet-300/[0.10] px-1.5 py-0.5 text-[10px] text-violet-200">
                  {g.skillFocus}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Three-state goal status icon: achieved ✓ / partial ◐ / missed ✗. */
function GoalStatusIcon({ status }: { readonly status: 'achieved' | 'partial' | 'missed' }) {
  const { t } = useI18n();
  if (status === 'achieved') {
    return (
      <Check
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400"
        aria-label={t('pbl.v2.completion.scenario.goalAchieved')}
      />
    );
  }
  if (status === 'partial') {
    return (
      <Contrast
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300"
        aria-label={t('pbl.v2.completion.scenario.goalPartial')}
      />
    );
  }
  return (
    <X
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500"
      aria-label={t('pbl.v2.completion.scenario.goalMissed')}
    />
  );
}

function StageReviewItem({
  detail,
  index,
}: {
  readonly detail: StageDetail;
  readonly index: number;
}) {
  const { t } = useI18n();
  const hasContent =
    detail.conceptsInStage.length > 0 || detail.submissionsInStage > 0 || detail.isCoreStage;

  return (
    <li className="rounded-xl border border-white/[0.05] bg-white/[0.03] px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-cyan-100/[0.10] text-[11px] font-bold text-cyan-200/80">
          {index + 1}
        </span>
        <span className="text-sm font-medium text-slate-100">
          {detail.milestoneTitle}
          {detail.isCoreStage && (
            <span className="ml-1.5 rounded-full border border-violet-300/20 bg-violet-300/[0.08] px-1.5 py-0.5 text-[10px] text-violet-200">
              {t('pbl.v2.completion.coreStageBadge')}
            </span>
          )}
        </span>
      </div>
      {hasContent ? (
        <ul className="mt-2 ml-7 space-y-1">
          {detail.conceptsInStage.length > 0 && (
            <li className="text-xs text-slate-400">
              <span className="mr-1 text-emerald-300/80">+</span>
              {t('pbl.v2.completion.conceptsInStageLabel')}
              {detail.conceptsInStage.map((c, ci) => (
                <span key={ci}>
                  <span className="inline-block rounded bg-cyan-100/[0.08] px-1.5 py-0.5 text-[11px] text-cyan-100">
                    {c}
                  </span>
                  {ci < detail.conceptsInStage.length - 1 && (
                    <span className="text-slate-500">{'、'}</span>
                  )}
                </span>
              ))}
            </li>
          )}
          {detail.submissionsInStage > 0 && (
            <li className="text-xs text-slate-400">
              <span className="mr-1 text-cyan-300/80">+</span>
              {t('pbl.v2.completion.submissionsInStage', { count: detail.submissionsInStage })}
            </li>
          )}
          {detail.isCoreStage && detail.coreConcept && detail.synthesisQuality && (
            <li className="text-xs text-slate-200">
              <span className="mr-1 text-violet-300/80">+</span>
              {t('pbl.v2.completion.coreConceptGrasp', {
                concept: detail.coreConcept,
                quality: t(`pbl.v2.completion.synthesisQuality.${detail.synthesisQuality}`),
              })}
            </li>
          )}
        </ul>
      ) : (
        <p className="mt-1 ml-7 text-xs text-slate-500">{t('pbl.v2.completion.stageNoData')}</p>
      )}
    </li>
  );
}

function ReportSection({
  icon,
  title,
  items,
  fallback,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly items: readonly string[];
  readonly fallback: string;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5">
      <div className="mb-3.5 flex items-center gap-2 text-sm font-semibold text-slate-100">
        <span className="text-cyan-300">{icon}</span>
        {title}
      </div>
      {items.length ? (
        <ul className="space-y-2.5">
          {items.map((item, idx) => (
            <li
              key={`${idx}-${item}`}
              className="flex gap-2.5 text-sm leading-relaxed text-slate-300"
            >
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300/60" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-400">{fallback}</p>
      )}
    </section>
  );
}
