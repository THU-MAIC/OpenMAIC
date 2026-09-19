'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { animate, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { FileText, HelpCircle, Gamepad2, Puzzle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import type { Scene, SceneType } from '@/lib/types/stage';
import {
  completeSummaryForScenes,
  pendingCompleteSummary,
  readSceneQuizAnswers,
  summarizeScenes,
} from '@/lib/classroom/complete-summary';
import { loadQuizAttemptState } from '@/lib/quiz/runtime';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomComplete');

const SCENE_TYPE_ICONS: Record<SceneType, typeof FileText> = {
  slide: FileText,
  quiz: HelpCircle,
  interactive: Gamepad2,
  pbl: Puzzle,
};

const TYPE_ORDER: SceneType[] = ['slide', 'quiz', 'interactive', 'pbl'];

const CONFETTI_COLORS = [
  '#fbbf24',
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#a855f7',
  '#3b82f6',
  '#10b981',
];

function encouragementKey(pct: number): 'high' | 'mid' | 'low' {
  if (pct >= 90) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

interface Particle {
  id: number;
  x: number;
  y: number;
  rotate: number;
  color: string;
  w: number;
  h: number;
  duration: number;
  delay: number;
  round: boolean;
}

function makeConfetti(count: number): Particle[] {
  const arr: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.45;
    const distance = 180 + Math.random() * 280;
    const w = 6 + Math.random() * 6;
    arr.push({
      id: i,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance - 50,
      rotate: (Math.random() - 0.5) * 720,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      w,
      h: Math.random() > 0.3 ? w * 0.4 : w,
      duration: 1.0 + Math.random() * 0.9,
      delay: Math.random() * 0.12,
      round: Math.random() > 0.72,
    });
  }
  return arr;
}

function Confetti() {
  const prefersReducedMotion = useReducedMotion();
  const particles = useMemo(() => makeConfetti(55), []);
  if (prefersReducedMotion) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-visible"
    >
      {particles.map((p) => (
        <motion.div
          key={p.id}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.2 }}
          animate={{
            x: p.x,
            y: p.y + 220,
            opacity: 0,
            rotate: p.rotate,
            scale: 1,
          }}
          transition={{ duration: p.duration, delay: p.delay, ease: [0.1, 0.5, 0.4, 1] }}
          style={{
            position: 'absolute',
            width: p.w,
            height: p.h,
            backgroundColor: p.color,
            borderRadius: p.round ? '50%' : 2,
          }}
        />
      ))}
    </div>
  );
}

function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <path d="M10 1 L12 8 L19 10 L12 12 L10 19 L8 12 L1 10 L8 8 Z" fill="currentColor" />
    </svg>
  );
}

function Sparkles() {
  const prefersReducedMotion = useReducedMotion();
  const sparkles = useMemo(
    () => [
      { x: -95, y: -40, size: 14, delay: 0.8, repeatDelay: 0.8 },
      { x: 95, y: -20, size: 18, delay: 1.1, repeatDelay: 1.0 },
      { x: -78, y: 55, size: 11, delay: 1.35, repeatDelay: 1.2 },
      { x: 82, y: 62, size: 15, delay: 1.55, repeatDelay: 0.9 },
      { x: 0, y: -88, size: 10, delay: 1.75, repeatDelay: 1.1 },
    ],
    [],
  );
  if (prefersReducedMotion) return null;

  return (
    <>
      {sparkles.map((s, i) => (
        <motion.div
          key={i}
          aria-hidden
          className="absolute text-amber-300 dark:text-amber-200"
          style={{
            width: s.size,
            height: s.size,
            left: `calc(50% + ${s.x}px - ${s.size / 2}px)`,
            top: `calc(50% + ${s.y}px - ${s.size / 2}px)`,
          }}
          initial={{ scale: 0, opacity: 0, rotate: 0 }}
          animate={{ scale: [0, 1, 0.7, 1, 0], opacity: [0, 1, 0.7, 1, 0], rotate: 180 }}
          transition={{
            duration: 2.2,
            delay: s.delay,
            repeat: Infinity,
            repeatDelay: s.repeatDelay,
            ease: 'easeInOut',
          }}
        >
          <Sparkle className="w-full h-full" />
        </motion.div>
      ))}
    </>
  );
}

function TrophySvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 150" className={className} aria-hidden>
      <defs>
        <linearGradient id="tc-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fef3c7" />
          <stop offset="35%" stopColor="#fbbf24" />
          <stop offset="75%" stopColor="#d97706" />
          <stop offset="100%" stopColor="#92400e" />
        </linearGradient>
        <linearGradient id="tc-gold-light" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fcd34d" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#b45309" />
        </linearGradient>
        <linearGradient id="tc-shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fffbeb" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#fffbeb" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Handles */}
      <path
        d="M 28 32 Q 6 32 8 60 Q 10 82 32 86"
        fill="none"
        stroke="url(#tc-gold)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path
        d="M 92 32 Q 114 32 112 60 Q 110 82 88 86"
        fill="none"
        stroke="url(#tc-gold)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      {/* Cup */}
      <path d="M 25 18 L 95 18 L 95 50 Q 95 90 60 100 Q 25 90 25 50 Z" fill="url(#tc-gold)" />
      {/* Shine */}
      <path d="M 33 22 Q 32 60 42 88 L 38 88 Q 30 60 31 22 Z" fill="url(#tc-shine)" />
      {/* Rim */}
      <ellipse cx="60" cy="19" rx="36" ry="4.5" fill="#fde68a" />
      <ellipse
        cx="60"
        cy="19"
        rx="36"
        ry="4.5"
        fill="none"
        stroke="#b45309"
        strokeWidth="0.6"
        opacity="0.35"
      />
      {/* Star */}
      <path
        d="M 60 42 L 63.6 52.3 L 74.5 52.3 L 65.7 58.7 L 69 69 L 60 62.7 L 51 69 L 54.3 58.7 L 45.5 52.3 L 56.4 52.3 Z"
        fill="#ffffff"
        opacity="0.92"
      />
      {/* Stem */}
      <path d="M 52 100 L 68 100 L 66 116 L 54 116 Z" fill="url(#tc-gold)" />
      {/* Base tiers */}
      <rect x="40" y="116" width="40" height="7" rx="2" fill="url(#tc-gold-light)" />
      <rect x="32" y="123" width="56" height="9" rx="2" fill="url(#tc-gold)" />
      <rect x="28" y="132" width="64" height="6" rx="3" fill="url(#tc-gold-light)" />
    </svg>
  );
}

function AnimatedCounter({
  value,
  delay = 0,
  duration = 0.9,
}: {
  value: number;
  delay?: number;
  duration?: number;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion) return;
    const controls = animate(0, value, {
      delay,
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, delay, duration, prefersReducedMotion]);

  return <>{prefersReducedMotion ? value : display}</>;
}

function QuizRing({
  pct,
  delay = 0,
  compact = false,
}: {
  pct: number;
  delay?: number;
  compact?: boolean;
}) {
  const prefersReducedMotion = useReducedMotion();
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const size = compact ? 64 : 88;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 88 88" className="w-full h-full -rotate-90">
        <defs>
          <linearGradient id="tc-ring-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fbbf24" />
            <stop offset="100%" stopColor="#f97316" />
          </linearGradient>
        </defs>
        <circle
          cx="44"
          cy="44"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          className="text-amber-200/70 dark:text-amber-900/40"
        />
        <motion.circle
          cx="44"
          cy="44"
          r={radius}
          fill="none"
          stroke="url(#tc-ring-gold)"
          strokeWidth="8"
          strokeLinecap="round"
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - pct / 100) }}
          transition={{
            duration: prefersReducedMotion ? 0 : 1.1,
            delay,
            ease: [0.16, 1, 0.3, 1],
          }}
          style={{ strokeDasharray: circumference }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xl font-black text-amber-700 dark:text-amber-300">
          <AnimatedCounter value={pct} delay={delay} duration={1.0} />
          <span className="text-sm font-bold">%</span>
        </span>
      </div>
    </div>
  );
}

interface ClassroomCompletePageProps {
  readonly scenes: Scene[];
  readonly title: string;
}

export function ClassroomCompletePage({ scenes, title }: ClassroomCompletePageProps) {
  const { t, locale } = useI18n();
  const prefersReducedMotion = useReducedMotion();

  const [resolvedSummary, setResolvedSummary] = useState(() => ({
    scenes,
    summary: pendingCompleteSummary(scenes),
  }));
  const summary = completeSummaryForScenes(scenes, resolvedSummary);

  useEffect(() => {
    let cancelled = false;
    void summarizeScenes(scenes, async (sceneId) => {
      const scene = scenes.find((candidate) => candidate.id === sceneId);
      try {
        return await readSceneQuizAnswers(scene, loadQuizAttemptState);
      } catch (error) {
        log.warn(`Failed to load quiz summary for scene ${sceneId}:`, error);
        return undefined;
      }
    }).then((next) => {
      if (!cancelled) setResolvedSummary({ scenes, summary: next });
    });
    return () => {
      cancelled = true;
    };
  }, [scenes]);

  const dateLabel = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(locale).format(new Date());
    } catch {
      return new Date().toLocaleDateString();
    }
  }, [locale]);

  const trailItems = TYPE_ORDER.filter((type) => (summary.countsByType[type] ?? 0) > 0).map(
    (type) => ({
      type,
      count: summary.countsByType[type] ?? 0,
      Icon: SCENE_TYPE_ICONS[type],
      label: t(`classroomComplete.trailLabels.${type}`),
    }),
  );

  // Adaptive compact mode. The complete page lives inside the `<Stage>`
  // viewport — when that viewport is short (e.g. user shrinks the browser, or
  // the stage is embedded in a thin column), the natural content (trophy +
  // ribbon + title + stats + quiz) overflows. A centered flex container that
  // overflows clips its top half beyond the scroll origin, so the trophy
  // becomes unreachable — instead of relying on scrolling, we toggle a
  // `compact` token before content overflows the container.
  //
  // We base the decision on the **container height alone**, not on
  // measuring content vs. container. Measuring content while in compact
  // would only see the compact size, so if we used "content + margin >
  // container" both ways, we'd ping-pong between the two layouts (compact
  // fits → swap to full → full overflows → swap to compact → repeat every
  // frame).
  //
  // Hysteresis on the container size avoids that:
  //   - flip TO compact when container drops below FULL_MIN
  //   - flip BACK to full only when container climbs above FULL_SAFE
  //
  // FULL_MIN matches the natural full-layout height (trophy + title + 4
  // stat cards + quiz card, all spaced); FULL_SAFE has a little headroom
  // on top of that so we don't oscillate around the seam.
  const sectionRef = useRef<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const FULL_MIN = 760; // below this height, full layout overflows
    const FULL_SAFE = 820; // only re-expand once we have this much again
    const measure = () => {
      const h = section.clientHeight;
      setCompact((prev) => (prev ? h < FULL_SAFE : h < FULL_MIN));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(section);
    measure();
    return () => ro.disconnect();
  }, []);

  return (
    <MotionConfig reducedMotion={prefersReducedMotion ? 'always' : 'user'}>
      {/* Layering:
          - outer <section> is the viewport-sized stage; it owns the
            absolute-positioned decorative layers (background gradient,
            radial glow, confetti) and stays overflow-hidden so the
            sparkles/confetti that intentionally overshoot don't make a
            scrollbar appear.
          - inside, an absolutely-positioned scroll container owns the
            content. The scroll container is overflow-y:auto so when content
            is taller than the section the user can scroll, but because the
            decorative layers live *outside* this scroll container they
            stay pinned to the viewport instead of extending below the
            content (which previously caused a large empty area below the
            content — gradients followed the scroll height).
          - inside the scroll container, a flex wrapper with min-h-full +
            items-center keeps content vertically centered when it fits,
            and expands past min-height when content overflows (which gives
            natural scrolling without trailing whitespace). Note the wrapper
            itself must not be the scroll container: a centered flex child
            that overflows is clipped beyond the scroll origin at the top,
            which is exactly what the compact token above avoids, and the
            scroll layer keeps that path degenerate. */}
      <section
        ref={sectionRef}
        className="absolute inset-0 z-[105] overflow-hidden"
        aria-label={t('classroomComplete.title')}
      >
        {/* Single-shot announcement for screen readers — replaces the noisy
            outer aria-live region that used to wrap the live-updating counters. */}
        <span className="sr-only" role="status">
          {t('classroomComplete.title')}
        </span>
        {/* Base background — pinned to the section, NOT to scroll height */}
        <div className="absolute inset-0 bg-gradient-to-br from-amber-50 via-white to-orange-50 dark:from-gray-900 dark:via-gray-900 dark:to-amber-950/30" />
        {/* Radial glow — same, pinned to section */}
        <motion.div
          aria-hidden
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 50% 42%, rgba(251, 191, 36, 0.32), rgba(249, 115, 22, 0.12) 38%, transparent 68%)',
          }}
        />
        {/* Confetti — pinned to section */}
        <Confetti />

        {/* Scroll layer: only this part scrolls when content overflows. */}
        <div className="absolute inset-0 overflow-y-auto overflow-x-hidden">
          <div className="min-h-full flex items-center justify-center">
            {/* Content */}
            <div
              className={cn(
                'relative flex flex-col items-center max-w-2xl w-full',
                compact ? 'gap-3 px-6 py-4' : 'gap-6 px-8 py-10',
              )}
            >
              {/* Trophy + halo + sparkles */}
              <div
                className="relative"
                style={{ width: compact ? 120 : 200, height: compact ? 120 : 200 }}
              >
                <motion.div
                  aria-hidden
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: [0.9, 1.15, 0.95, 1.1], opacity: [0, 0.55, 0.4, 0.5] }}
                  transition={{
                    delay: 0.15,
                    duration: 2.6,
                    repeat: Infinity,
                    repeatType: 'reverse',
                    ease: 'easeInOut',
                  }}
                  className="absolute inset-0 rounded-full"
                  style={{
                    background:
                      'radial-gradient(circle, rgba(251, 191, 36, 0.5), rgba(249, 115, 22, 0.12) 55%, transparent 72%)',
                    filter: 'blur(14px)',
                  }}
                />
                <motion.div
                  aria-hidden
                  initial={{ y: 44, scale: 0.4, opacity: 0 }}
                  animate={{ y: 0, scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.2 }}
                  className="absolute inset-0 flex items-center justify-center"
                >
                  <motion.div
                    animate={{ y: [0, -5, 0] }}
                    transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                    style={{
                      width: compact ? 90 : 148,
                      height: compact ? 112 : 185,
                    }}
                  >
                    <TrophySvg className="w-full h-full drop-shadow-[0_10px_18px_rgba(180,83,9,0.35)]" />
                  </motion.div>
                </motion.div>
                {!compact && <Sparkles />}
              </div>

              {/* Ribbon */}
              <motion.div
                initial={{ opacity: 0, scale: 0.7, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ delay: 0.65, type: 'spring', stiffness: 280, damping: 18 }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-500 text-white font-bold uppercase tracking-wider shadow-lg shadow-amber-500/30',
                  compact ? 'px-3 py-1 text-[10px]' : 'px-4 py-1.5 text-xs',
                )}
              >
                <Sparkle className="w-3 h-3" />
                {t('classroomComplete.title')}
                <Sparkle className="w-3 h-3" />
              </motion.div>

              {/* Title + date */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.78, duration: 0.4, ease: 'easeOut' }}
                className={cn('text-center', compact ? 'space-y-0.5' : 'space-y-1.5')}
              >
                <h2
                  className={cn(
                    'font-black leading-tight bg-gradient-to-br from-amber-700 via-orange-600 to-amber-800 dark:from-amber-200 dark:via-orange-200 dark:to-amber-300 bg-clip-text text-transparent',
                    compact ? 'text-xl md:text-2xl' : 'text-3xl md:text-4xl',
                  )}
                >
                  {title || t('classroomComplete.title')}
                </h2>
                <p
                  className={cn(
                    'text-gray-500 dark:text-gray-400',
                    compact ? 'text-xs' : 'text-sm',
                  )}
                >
                  {dateLabel}
                </p>
              </motion.div>

              {/* Stats cards */}
              {trailItems.length > 0 && (
                <div
                  className={cn(
                    'grid w-full',
                    compact ? 'gap-2' : 'gap-3',
                    trailItems.length === 1 && 'grid-cols-1 max-w-[180px]',
                    trailItems.length === 2 && 'grid-cols-2 max-w-md',
                    trailItems.length === 3 && 'grid-cols-3',
                    trailItems.length === 4 && 'grid-cols-2 sm:grid-cols-4',
                  )}
                >
                  {trailItems.map(({ type, count, Icon, label }, idx) => {
                    const cardDelay = 0.96 + idx * 0.08;
                    return (
                      <motion.div
                        key={type}
                        initial={{ opacity: 0, y: 14, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{
                          delay: cardDelay,
                          type: 'spring',
                          stiffness: 260,
                          damping: 20,
                        }}
                        className={cn(
                          'rounded-2xl bg-white/90 dark:bg-gray-900/70 border border-amber-100 dark:border-amber-900/40 shadow-sm flex flex-col items-center backdrop-blur-sm',
                          compact ? 'px-3 py-2 gap-0.5' : 'px-4 py-4 gap-1.5',
                        )}
                      >
                        <Icon
                          className={cn(
                            'text-amber-500 dark:text-amber-400',
                            compact ? 'w-4 h-4' : 'w-6 h-6',
                          )}
                          strokeWidth={1.8}
                        />
                        <div
                          className={cn(
                            'font-black text-gray-900 dark:text-gray-100 leading-none',
                            compact ? 'text-xl' : 'text-3xl',
                          )}
                        >
                          <AnimatedCounter value={count} delay={cardDelay + 0.15} />
                        </div>
                        <div
                          className={cn(
                            'text-gray-500 dark:text-gray-400 uppercase tracking-wider',
                            compact ? 'text-[10px]' : 'text-[11px]',
                          )}
                        >
                          {label}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}

              {/* Quiz card */}
              {summary.quiz && (
                <motion.div
                  initial={{ opacity: 0, y: 14, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ delay: 1.2, type: 'spring', stiffness: 220, damping: 20 }}
                  className={cn(
                    'w-full rounded-2xl bg-gradient-to-br from-amber-100 via-orange-50 to-amber-100 dark:from-amber-950/50 dark:via-orange-950/30 dark:to-amber-950/50 border border-amber-200 dark:border-amber-900/50 shadow-md shadow-amber-200/30 dark:shadow-amber-950/20',
                    compact ? 'px-4 py-3' : 'px-6 py-5',
                  )}
                >
                  <div className={cn('flex items-center', compact ? 'gap-3' : 'gap-5')}>
                    <QuizRing pct={summary.quiz.pct} delay={1.3} compact={compact} />
                    <div className="flex-1 min-w-0">
                      <div
                        className={cn(
                          'font-bold text-amber-700 dark:text-amber-300',
                          compact ? 'text-sm' : 'text-base',
                        )}
                      >
                        {t('classroomComplete.quizScoreLabel', {
                          correct: summary.quiz.correct,
                          total: summary.quiz.total,
                        })}
                      </div>
                      <div
                        className={cn(
                          'mt-1 text-amber-700/80 dark:text-amber-300/80',
                          compact ? 'text-xs' : 'text-sm',
                        )}
                      >
                        {t(`classroomComplete.encouragement.${encouragementKey(summary.quiz.pct)}`)}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </section>
    </MotionConfig>
  );
}

export function ClassroomCompletePageConnected() {
  const stage = useStageStore((s) => s.stage);
  const scenes = useStageStore((s) => s.scenes);
  return <ClassroomCompletePage scenes={scenes} title={stage?.name ?? ''} />;
}
