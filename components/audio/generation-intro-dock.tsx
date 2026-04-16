'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, ChevronUp, Loader2, Mic2, Volume2, VolumeX } from 'lucide-react';
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
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);

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
            {!expanded ? (
              <div className="flex items-center gap-2">
                <div
                  className="shrink-0 rounded-lg p-2 bg-violet-500/10"
                  aria-hidden
                >
                  {status === 'generating' ? (
                    <Loader2 className="size-5 text-violet-600 dark:text-violet-400 animate-spin" />
                  ) : (
                    <Mic2
                      className={`size-5 text-violet-600 dark:text-violet-400 ${status === 'streaming' ? 'animate-pulse' : ''}`}
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-600/85 dark:text-violet-300/85">
                    {status === 'generating' ? 'Preparing intro' : 'Playing intro'}
                  </p>
                  <p className="text-xs font-medium text-foreground/90 truncate">{courseName}</p>
                </div>
                <button
                  type="button"
                  onClick={onToggleMute}
                  className="shrink-0 rounded-full p-2 hover:bg-violet-500/10 transition-colors ring-offset-2 ring-offset-white dark:ring-offset-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  title={muted ? 'Unmute intro' : 'Mute intro'}
                  aria-pressed={muted}
                  aria-label={muted ? 'Unmute intro audio' : 'Mute intro audio'}
                >
                  {muted ? (
                    <VolumeX className="size-4 text-destructive" />
                  ) : (
                    <Volume2 className="size-4 text-violet-600 dark:text-violet-400" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="shrink-0 rounded-full p-2 hover:bg-violet-500/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  title="Show transcript"
                  aria-expanded={false}
                >
                  <ChevronUp className="size-4 text-muted-foreground" />
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <div
                    className="shrink-0 mt-0.5 rounded-lg p-1.5 bg-violet-500/10"
                    aria-hidden
                  >
                    {status === 'generating' ? (
                      <Loader2 className="size-5 text-violet-600 dark:text-violet-400 animate-spin" />
                    ) : (
                      <Mic2
                        className={`size-5 text-violet-600 dark:text-violet-400 ${status === 'streaming' ? 'animate-pulse' : ''}`}
                      />
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
                  <div className="flex shrink-0 flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={onToggleMute}
                      className="rounded-full p-2 hover:bg-violet-500/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                      title={muted ? 'Unmute intro' : 'Mute intro'}
                      aria-pressed={muted}
                      aria-label={muted ? 'Unmute intro audio' : 'Mute intro audio'}
                    >
                      {muted ? (
                        <VolumeX className="size-4 text-destructive" />
                      ) : (
                        <Volume2 className="size-4 text-violet-600 dark:text-violet-400" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpanded(false)}
                      className="rounded-full p-2 hover:bg-violet-500/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                      title="Hide transcript"
                      aria-expanded
                    >
                      <ChevronDown className="size-4 text-muted-foreground" />
                    </button>
                  </div>
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
              </>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
