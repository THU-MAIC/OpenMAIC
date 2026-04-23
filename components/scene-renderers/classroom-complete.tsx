'use client';

import { useMemo } from 'react';
import { motion } from 'motion/react';
import { FileText, HelpCircle, Gamepad2, Puzzle, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import type { Scene, SceneType } from '@/lib/types/stage';
import { summarizeScenes } from '@/lib/classroom/complete-summary';

const SCENE_TYPE_ICONS: Record<SceneType, typeof FileText> = {
  slide: FileText,
  quiz: HelpCircle,
  interactive: Gamepad2,
  pbl: Puzzle,
};

const TYPE_ORDER: SceneType[] = ['slide', 'quiz', 'interactive', 'pbl'];

function readQuizAnswers(sceneId: string): Record<string, string | string[]> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(`quizDraft:${sceneId}`);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string | string[]>;
  } catch {
    return {};
  }
}

function encouragementKey(pct: number): 'high' | 'mid' | 'low' {
  if (pct >= 90) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

interface ClassroomCompletePageProps {
  readonly scenes: Scene[];
  readonly title: string;
}

export function ClassroomCompletePage({ scenes, title }: ClassroomCompletePageProps) {
  const { t, locale } = useI18n();

  const summary = useMemo(() => summarizeScenes(scenes, readQuizAnswers), [scenes]);

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

  return (
    <div className="absolute inset-0 z-[105] flex items-center justify-center bg-white dark:bg-gray-800 overflow-auto">
      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 40%, rgba(250, 204, 21, 0.18), transparent 60%)',
        }}
      />

      <div className="relative flex flex-col items-center gap-6 max-w-xl w-full px-8 py-10">
        <motion.div
          initial={{ y: 40, scale: 0.6, opacity: 0 }}
          animate={{ y: 0, scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 18, duration: 0.6 }}
        >
          <div className="relative">
            <div className="absolute inset-0 rounded-full bg-amber-200/40 dark:bg-amber-400/10 blur-2xl" />
            <Trophy
              className="relative w-20 h-20 text-amber-500 dark:text-amber-400"
              strokeWidth={1.5}
            />
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.72, duration: 0.35, ease: 'easeOut' }}
          className="text-center"
        >
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {title || t('classroomComplete.title')}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('classroomComplete.title')} · {dateLabel}
          </p>
        </motion.div>

        {trailItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.84, duration: 0.35, ease: 'easeOut' }}
            className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
          >
            {trailItems.map(({ type, count, Icon, label }) => (
              <div
                key={type}
                className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300"
              >
                <Icon className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                <span className="font-semibold">{count}</span>
                <span className="text-gray-500 dark:text-gray-400">{label}</span>
              </div>
            ))}
          </motion.div>
        )}

        {summary.quiz && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.96, duration: 0.35, ease: 'easeOut' }}
            className={cn(
              'w-full rounded-lg px-5 py-4 text-center',
              'bg-amber-50 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/40',
            )}
          >
            <div className="text-lg font-semibold text-amber-700 dark:text-amber-300">
              {t('classroomComplete.quizScoreLabel', {
                correct: summary.quiz.correct,
                total: summary.quiz.total,
              })}
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                · {summary.quiz.pct}%
              </span>
            </div>
            <div className="mt-1 text-sm text-amber-700/80 dark:text-amber-300/80">
              {t(`classroomComplete.encouragement.${encouragementKey(summary.quiz.pct)}`)}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}

/** Wrapper that sources data from the stage store. Convenience for call sites. */
export function ClassroomCompletePageConnected() {
  const stage = useStageStore((s) => s.stage);
  const scenes = useStageStore((s) => s.scenes);
  return <ClassroomCompletePage scenes={scenes} title={stage?.name ?? ''} />;
}
