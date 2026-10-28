'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AgentRevealCard } from './agent-reveal-card';

interface AgentRevealModalProps {
  agents: Array<{
    id: string;
    name: string;
    role: string;
    persona: string;
    avatar: string;
    color: string;
  }>;
  open: boolean;
  onClose: () => void;
  /** Called once after all cards are revealed — signals generation can continue */
  onAllRevealed?: () => void;
}

export function AgentRevealModal({ agents, open, onClose, onAllRevealed }: AgentRevealModalProps) {
  const { t } = useI18n();
  const [revealedCount, setRevealedCount] = useState(0);
  const [flipsComplete, setFlipsComplete] = useState(false);
  const allRevealedFiredRef = useRef(false);
  const onAllRevealedRef = useRef(onAllRevealed);
  onAllRevealedRef.current = onAllRevealed;

  const allRevealed = revealedCount >= agents.length && agents.length > 0;

  useEffect(() => {
    if (!open) {
      setRevealedCount(0);
      setFlipsComplete(false);
      allRevealedFiredRef.current = false;
      return;
    }

    let i = 0;
    const startTimeout = setTimeout(() => {
      i = 1;
      setRevealedCount(1);

      if (agents.length <= 1) {
        setTimeout(() => {
          if (!allRevealedFiredRef.current) {
            allRevealedFiredRef.current = true;
            onAllRevealedRef.current?.();
          }
        }, 600);
        return;
      }

      const interval = setInterval(() => {
        i++;
        setRevealedCount(i);
        if (i >= agents.length) {
          clearInterval(interval);
          setTimeout(() => {
            if (!allRevealedFiredRef.current) {
              allRevealedFiredRef.current = true;
              onAllRevealedRef.current?.();
            }
          }, 600);
        }
      }, 500);

      return () => clearInterval(interval);
    }, 400);

    return () => clearTimeout(startTimeout);
  }, [open, agents.length]);

  // Switch from preserve-3d to flat after all flip animations complete to enable scrolling
  useEffect(() => {
    if (!allRevealed) return;
    const timer = setTimeout(() => setFlipsComplete(true), 800);
    return () => clearTimeout(timer);
  }, [allRevealed]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-zinc-100/90 backdrop-blur-sm dark:bg-black/70 dark:backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Close button */}
          {allRevealed && (
            <motion.button
              className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-black/5 text-zinc-500 backdrop-blur-sm transition-colors hover:bg-black/10 hover:text-zinc-700 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/20 dark:hover:text-white"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.2, duration: 0.2 }}
              onClick={onClose}
            >
              <X className="size-5" />
            </motion.button>
          )}

          {/* Title */}
          <motion.h2
            className="mb-8 text-2xl font-bold text-zinc-800 drop-shadow-sm dark:text-white dark:drop-shadow-lg md:text-3xl"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.4 }}
          >
            <Sparkles className="mr-2 inline-block size-6 text-amber-500 dark:text-yellow-400" />
            {t('generation.agentRevealTitle')}
          </motion.h2>

          {/* Cards */}
          <div className="flex flex-wrap items-stretch justify-center gap-4 px-4 md:gap-5">
            {agents.map((agent, index) => (
              <AgentRevealCard
                key={agent.id}
                agent={agent}
                index={index}
                isRevealed={index < revealedCount}
                flipsComplete={flipsComplete}
              />
            ))}
          </div>

          {/* Progress dots + continue */}
          <motion.div
            className="mt-6 flex flex-col items-center gap-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
          >
            <div className="flex gap-1.5">
              {agents.map((_, index) => (
                <div
                  key={index}
                  className={cn(
                    'size-2 rounded-full transition-colors duration-300',
                    index < revealedCount
                      ? 'bg-zinc-700 dark:bg-white'
                      : 'bg-zinc-300 dark:bg-white/30',
                  )}
                />
              ))}
            </div>

            {allRevealed && (
              <motion.button
                className="rounded-full bg-zinc-800 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white/15 dark:hover:bg-white/25"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.3 }}
                onClick={onClose}
              >
                {t('generation.continue')}
              </motion.button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
