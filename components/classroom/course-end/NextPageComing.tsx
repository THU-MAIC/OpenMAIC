'use client';

/**
 * The learner reached the last page while the course is still being built: a quiet
 * note at the foot of the page instead of the end, gone the moment the next page lands.
 */
import { motion } from 'motion/react';
import { useI18n } from '@/lib/hooks/use-i18n';

export function NextPageComing() {
  const { t } = useI18n();
  return (
    <motion.div
      className="pointer-events-none absolute inset-x-0 bottom-5 z-[120] flex justify-center"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <div
        role="status"
        aria-live="polite"
        data-testid="next-page-coming"
        className="flex items-center gap-2 rounded-full border border-slate-900/10 bg-white/90 px-3.5 py-1.5 text-[13px] text-slate-600 shadow-[0_6px_20px_-8px_rgba(76,29,149,0.35)] backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/85 dark:text-slate-300 dark:shadow-[0_6px_20px_-8px_rgba(0,0,0,0.7)]"
      >
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-400 opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-violet-500 dark:bg-violet-400" />
        </span>
        {t('classroomEnd.nextPageComing')}
      </div>
    </motion.div>
  );
}
