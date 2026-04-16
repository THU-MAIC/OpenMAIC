'use client';

import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Volume2, VolumeX } from 'lucide-react';
import type { IntroSseStatus } from '@/lib/generation/intro-sse-client';

type DockStatus = 'idle' | IntroSseStatus;

export function GenerationIntroDock({
  open,
  courseName,
  script,
  status,
  muted,
  onToggleMute,
}: {
  open: boolean;
  courseName: string;
  script: string;
  status: DockStatus;
  muted: boolean;
  onToggleMute: () => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 28 }}
          transition={{ type: 'spring', stiffness: 340, damping: 30 }}
          className="fixed right-3 top-20 z-[45] w-[min(22rem,calc(100vw-1.5rem))] text-left pointer-events-auto"
          aria-label="Course intro audio"
        >
          <div className="rounded-2xl border border-violet-200/70 dark:border-violet-500/30 bg-white/92 dark:bg-slate-950/92 backdrop-blur-xl shadow-xl shadow-violet-500/15 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">
                {status === 'generating' ? (
                  <Loader2 className="size-5 text-violet-600 dark:text-violet-400 animate-spin" />
                ) : (
                  <Volume2 className={`size-5 text-violet-600 dark:text-violet-400 ${status === 'streaming' ? 'animate-pulse' : ''}`} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-600/85 dark:text-violet-300/85 mb-1">
                  {status === 'generating' ? 'Preparing intro' : 'Playing intro'}
                </p>
                <p className="text-xs font-medium text-foreground/90 line-clamp-2">{courseName}</p>
                <p className="text-sm text-muted-foreground mt-2 leading-snug line-clamp-6">
                  {script || '…'}
                </p>
              </div>
              <button
                type="button"
                onClick={onToggleMute}
                className="shrink-0 rounded-full p-2 hover:bg-violet-500/10 transition-colors"
                title={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? (
                  <VolumeX className="size-4 text-destructive" />
                ) : (
                  <Volume2 className="size-4 text-violet-600 dark:text-violet-400" />
                )}
              </button>
            </div>
            {status === 'streaming' && (
              <div className="flex gap-0.5 h-3 items-end justify-end pr-1">
                {[0, 1, 2, 3].map((i) => (
                  <motion.span
                    key={i}
                    className="w-0.5 rounded-full bg-violet-500/80"
                    animate={{ height: [3, 12, 4, 12, 3] }}
                    transition={{ duration: 0.55, repeat: Infinity, delay: i * 0.09 }}
                  />
                ))}
              </div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
