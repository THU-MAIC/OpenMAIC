'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ScanLine,
  Search,
  Globe,
  MousePointer2,
  BarChart3,
  Puzzle,
  Clapperboard,
  MessageSquare,
  Focus,
  Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SceneOutline } from '@/lib/types/generation';

// Step-specific visualizers
export function StepVisualizer({
  stepId,
  outlines,
  webSearchSources,
}: {
  stepId: string;
  outlines?: SceneOutline[] | null;
  webSearchSources?: Array<{ title: string; url: string }>;
}) {
  switch (stepId) {
    case 'pdf-analysis':
      return <PdfScanVisualizer />;
    case 'web-search':
      return <WebSearchVisualizer sources={webSearchSources || []} />;
    case 'outline':
      return <StreamingOutlineVisualizer outlines={outlines || []} />;
    case 'agent-generation':
      return <AgentGenerationVisualizer />;
    case 'slide-content':
      return <ContentVisualizer />;
    case 'actions':
      return <ActionsVisualizer />;
    default:
      return null;
  }
}

// PDF: Document with scanning laser line
function PdfScanVisualizer() {
  return (
    <div className="size-32 relative flex items-center justify-center">
      <motion.div
        className="absolute inset-2 bg-cyan-500/5 rounded-2xl blur-lg"
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 2, repeat: Infinity }}
      />
      <div className="w-20 h-28 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-xl relative overflow-hidden">
        <div className="p-3 space-y-2 mt-1">
          {[80, 60, 90, 45, 70].map((w, i) => (
            <motion.div
              key={i}
              className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded"
              style={{ width: `${w}%` }}
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 2, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </div>
        {/* Scanning laser */}
        <motion.div
          className="absolute inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_12px_rgba(34,211,238,0.6)]"
          animate={{ top: ['5%', '90%', '5%'] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>
      <motion.div
        className="absolute -top-1 -right-1"
        animate={{ rotate: [0, 10, -10, 0] }}
        transition={{ duration: 3, repeat: Infinity }}
      >
        <ScanLine className="size-6 text-cyan-500/70" />
      </motion.div>
    </div>
  );
}

// Web Search: Miniature search engine results page with animated query + result rows
function WebSearchVisualizer({ sources }: { sources: Array<{ title: string; url: string }> }) {
  const [activeResult, setActiveResult] = useState(0);

  // Cycle through result highlight when we have sources
  useEffect(() => {
    if (sources.length === 0) return;
    const timer = setInterval(() => {
      setActiveResult((prev) => (prev + 1) % Math.min(sources.length, 4));
    }, 1400);
    return () => clearInterval(timer);
  }, [sources.length]);

  // Placeholder results for skeleton state
  const skeletonResults = [
    { titleW: 70, urlW: 45, snippetW: [90, 60] },
    { titleW: 55, urlW: 50, snippetW: [80, 75] },
    { titleW: 65, urlW: 40, snippetW: [85, 50] },
    { titleW: 50, urlW: 55, snippetW: [70, 65] },
  ];

  const ROW_H = 38;

  return (
    <div className="size-56 relative flex items-center justify-center">
      {/* Background glow */}
      <motion.div
        className="absolute inset-0 blur-3xl rounded-full bg-teal-500/8"
        animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 3.5, repeat: Infinity }}
      />

      {/* Search results card */}
      <div className="w-44 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden relative">
        {/* Search bar header */}
        <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700 flex items-center gap-2">
          <Search className="size-3 text-teal-500 shrink-0" />
          <div className="flex-1 h-4 bg-slate-50 dark:bg-slate-700/50 rounded-full overflow-hidden flex items-center px-2">
            <motion.div
              className="h-1.5 bg-teal-500/25 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: '70%' }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
          </div>
        </div>

        {/* Results list */}
        <div className="p-2 space-y-0.5 relative">
          {/* Sliding highlight */}
          {sources.length > 0 && (
            <motion.div
              className="absolute left-2 right-2 rounded-lg bg-teal-500/[0.06] dark:bg-teal-400/[0.08]"
              style={{ height: ROW_H - 6 }}
              animate={{ y: activeResult * ROW_H }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            />
          )}

          {sources.length === 0
            ? // Skeleton: pulsing result placeholders
              skeletonResults.map((item, i) => (
                <motion.div
                  key={i}
                  className="px-2 py-1.5 space-y-1"
                  animate={{ opacity: [0.3, 0.7, 0.3] }}
                  transition={{
                    duration: 1.4,
                    repeat: Infinity,
                    delay: i * 0.15,
                  }}
                >
                  <div
                    className="h-1.5 bg-teal-200/40 dark:bg-teal-800/30 rounded"
                    style={{ width: `${item.titleW}%` }}
                  />
                  <div
                    className="h-1 bg-slate-100 dark:bg-slate-700 rounded"
                    style={{ width: `${item.urlW}%` }}
                  />
                  <div className="flex gap-1">
                    {item.snippetW.map((w, j) => (
                      <div
                        key={j}
                        className="h-1 bg-slate-100 dark:bg-slate-700 rounded"
                        style={{ width: `${w * 0.5}%` }}
                      />
                    ))}
                  </div>
                </motion.div>
              ))
            : // Live results
              sources.slice(0, 4).map((source, i) => {
                const isActive = i === activeResult;
                return (
                  <motion.div
                    key={source.url}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.08, duration: 0.25 }}
                    className="relative px-2 py-1.5 space-y-0.5"
                  >
                    <div
                      className={cn(
                        'text-[8px] font-semibold truncate transition-colors duration-300 leading-tight',
                        isActive
                          ? 'text-teal-600 dark:text-teal-400'
                          : 'text-slate-600 dark:text-slate-400',
                      )}
                    >
                      {source.title}
                    </div>
                    <div className="text-[6px] text-teal-500/50 truncate leading-tight">
                      {source.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 32)}
                    </div>
                    <div className="flex gap-1">
                      <div className="h-0.5 flex-1 bg-slate-100 dark:bg-slate-700 rounded-full" />
                      <div className="h-0.5 w-1/3 bg-slate-100 dark:bg-slate-700 rounded-full" />
                    </div>
                  </motion.div>
                );
              })}
        </div>

        {/* Scanning beam */}
        <motion.div
          className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/20 dark:via-white/5 to-transparent -skew-x-12 pointer-events-none"
          initial={{ left: '-150%' }}
          animate={{ left: '200%' }}
          transition={{
            duration: 2,
            repeat: Infinity,
            repeatDelay: 2,
            ease: 'linear',
          }}
        />
      </div>

      {/* Source count badge */}
      {sources.length > 0 && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 15 }}
          className="absolute -top-2 -right-2 h-6 px-2 rounded-full bg-teal-500 text-white text-[10px] font-bold flex items-center justify-center shadow-lg shadow-teal-500/25 z-20 gap-0.5"
        >
          <Globe className="size-2.5" />
          {sources.length}
        </motion.div>
      )}
    </div>
  );
}

// Outline: Streams real outline data as it arrives from SSE
function StreamingOutlineVisualizer({ outlines }: { outlines: SceneOutline[] }) {
  // Build display lines from outlines
  const allLines: string[] = [];
  outlines.forEach((outline, i) => {
    allLines.push(`${i + 1}. ${outline.title}`);
    outline.keyPoints?.slice(0, 2).forEach((kp) => {
      const text = kp.length > 18 ? kp.substring(0, 18) + '...' : kp;
      allLines.push(`   • ${text}`);
    });
  });

  return (
    <div className="w-40 h-52 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl p-4 overflow-hidden relative rotate-[-2deg] hover:rotate-0 transition-transform duration-500">
      <div className="absolute top-0 inset-x-0 h-1 bg-blue-500/50" />
      <div className="w-1/3 h-2 bg-slate-100 dark:bg-slate-700 rounded mb-3" />
      <div className="space-y-1.5 font-mono text-[8px] text-muted-foreground leading-tight">
        {allLines.length === 0 ? (
          // Waiting for first outline — show placeholder skeleton
          <div className="space-y-2">
            {[60, 80, 50, 70].map((w, i) => (
              <motion.div
                key={i}
                className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded"
                style={{ width: `${w}%` }}
                animate={{ opacity: [0.3, 0.7, 0.3] }}
                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
              />
            ))}
          </div>
        ) : (
          allLines.map((line, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className={cn(
                'truncate',
                !line.startsWith('   ')
                  ? 'text-blue-600 dark:text-blue-400 font-semibold text-[9px]'
                  : 'pl-1 opacity-80',
              )}
            >
              {line}
            </motion.div>
          ))
        )}
      </div>
      <motion.div
        className="absolute bottom-3 right-3 size-2 bg-blue-500 rounded-full"
        animate={{ opacity: [0, 1, 0] }}
        transition={{ repeat: Infinity, duration: 0.8 }}
      />
    </div>
  );
}

// Content: Cycles through distinct representations of Slides, Quiz, PBL, Interactive
function AgentGenerationVisualizer() {
  return (
    <div className="w-60 h-40 mx-auto flex items-center justify-center">
      <div className="flex gap-3">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="w-14 h-20 rounded-lg bg-gradient-to-br from-purple-400 to-blue-500 dark:from-purple-600 dark:to-blue-700 shadow-lg"
            animate={{ y: [0, -8, 0], rotateZ: [0, 3, -3, 0] }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              delay: i * 0.3,
              ease: 'easeInOut',
            }}
          >
            <div className="w-full h-full flex items-center justify-center text-white/80 text-lg font-bold">
              ?
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function ContentVisualizer() {
  const [index, setIndex] = useState(0);

  // 0: Slide (Blue)
  // 1: Quiz (Purple)
  // 2: PBL (Amber)
  // 3: Interactive (Emerald)
  const totalTypes = 4;

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % totalTypes);
    }, 3200);
    return () => clearInterval(timer);
  }, []);

  const variants = {
    enter: { x: 50, opacity: 0, scale: 0.9, rotateY: -15 },
    center: { x: 0, opacity: 1, scale: 1, rotateY: 0 },
    exit: { x: -50, opacity: 0, scale: 0.9, rotateY: 15 },
  };

  const getTheme = (idx: number) => {
    switch (idx) {
      case 0:
        return {
          color: 'blue',
          label: 'SLIDE',
          badge:
            'bg-blue-100 text-blue-600 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800',
        };
      case 1:
        return {
          color: 'purple',
          label: 'QUIZ',
          badge:
            'bg-purple-100 text-purple-600 border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800',
        };
      case 2:
        return {
          color: 'amber',
          label: 'PBL',
          badge:
            'bg-amber-100 text-amber-600 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800',
        };
      case 3:
        return {
          color: 'emerald',
          label: 'WEB',
          badge:
            'bg-emerald-100 text-emerald-600 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800',
        };
      default:
        return { color: 'blue', label: '', badge: '' };
    }
  };

  const theme = getTheme(index);

  return (
    <div className="size-56 relative flex items-center justify-center perspective-[800px]">
      {/* Background glow based on current theme */}
      <motion.div
        key={`glow-${index}`}
        className={cn(
          'absolute inset-0 blur-3xl rounded-full transition-colors duration-1000',
          theme.color === 'blue' && 'bg-blue-500/10',
          theme.color === 'purple' && 'bg-purple-500/10',
          theme.color === 'amber' && 'bg-amber-500/10',
          theme.color === 'emerald' && 'bg-emerald-500/10',
        )}
        animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 4, repeat: Infinity }}
      />

      {/* Subtle orbiting rings (pushed back, slower) */}
      {[0, 1].map((i) => (
        <motion.div
          key={i}
          className={cn(
            'absolute border rounded-full transition-colors duration-1000',
            theme.color === 'blue' && 'border-blue-500/10',
            theme.color === 'purple' && 'border-purple-500/10',
            theme.color === 'amber' && 'border-amber-500/10',
            theme.color === 'emerald' && 'border-emerald-500/10',
          )}
          style={{
            width: 180 + i * 50,
            height: 180 + i * 50,
            borderStyle: 'dashed',
          }}
          animate={{ rotate: 360 }}
          transition={{
            duration: 40 + i * 15,
            ease: 'linear',
            repeat: Infinity,
            delay: i * -5,
          }}
        />
      ))}

      {/* Main Content Container */}
      <div className="w-40 h-28 relative">
        <AnimatePresence mode="popLayout">
          <motion.div
            key={index}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: 'spring', stiffness: 80, damping: 16 }}
            className={cn(
              'absolute inset-0 bg-white dark:bg-slate-800 rounded-xl border shadow-xl overflow-hidden flex flex-col p-3 origin-center',
              theme.color === 'blue' && 'border-blue-200 dark:border-blue-900/30',
              theme.color === 'purple' && 'border-purple-200 dark:border-purple-900/30',
              theme.color === 'amber' && 'border-amber-200 dark:border-amber-900/30',
              theme.color === 'emerald' && 'border-emerald-200 dark:border-emerald-900/30',
            )}
          >
            {/* Consistent Badge - Now outside content logic */}
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1 }}
              className={cn(
                'absolute top-1.5 right-1.5 z-20 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider border backdrop-blur-md shadow-sm',
                theme.badge,
              )}
            >
              {theme.label}
            </motion.div>

            {/* --- SLIDE TYPE --- */}
            {index === 0 && (
              <div className="flex flex-col h-full pt-1">
                <motion.div
                  initial={{ width: '0%' }}
                  animate={{ width: '55%' }}
                  transition={{ delay: 0.2 }}
                  className="h-2 bg-blue-500/20 rounded-full mb-3 shrink-0"
                />
                <div className="flex gap-2 flex-1">
                  <div className="flex-1 space-y-2">
                    {[0.8, 0.9, 0.6, 0.7].map((w, i) => (
                      <motion.div
                        key={i}
                        initial={{ width: 0 }}
                        animate={{ width: `${w * 100}%` }}
                        transition={{ delay: 0.3 + i * 0.1 }}
                        className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full"
                      />
                    ))}
                  </div>
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.4 }}
                    className="w-12 h-12 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center shrink-0"
                  >
                    <BarChart3 className="size-6 text-blue-500/60" />
                  </motion.div>
                </div>
              </div>
            )}

            {/* --- QUIZ TYPE --- */}
            {index === 1 && (
              <div className="flex flex-col h-full justify-center space-y-2 pt-2">
                <motion.div
                  initial={{ y: -5, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                  className="flex justify-center mb-1"
                >
                  <div className="h-2 w-3/4 bg-purple-500/20 rounded-full" />
                </motion.div>

                <div className="grid grid-cols-2 gap-2">
                  {[0, 1, 2, 3].map((i) => (
                    <motion.div
                      key={i}
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ delay: 0.3 + i * 0.1 }}
                      className={cn(
                        'h-6 rounded border flex items-center px-2',
                        i === 1
                          ? 'bg-purple-500 text-white border-purple-500'
                          : 'bg-slate-50 dark:bg-slate-700/50 border-slate-100 dark:border-slate-700',
                      )}
                    >
                      <div
                        className={cn(
                          'size-1.5 rounded-full mr-2',
                          i === 1 ? 'bg-white' : 'bg-slate-300',
                        )}
                      />
                      <div
                        className={cn(
                          'h-1 w-8 rounded-full',
                          i === 1 ? 'bg-white/50' : 'bg-slate-200 dark:bg-slate-600',
                        )}
                      />
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* --- PBL TYPE --- */}
            {index === 2 && (
              <div className="flex flex-col h-full pt-1">
                <div className="flex items-center gap-2 mb-2">
                  <Puzzle className="size-3 text-amber-500 shrink-0" />
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: '40%' }}
                    className="h-2 bg-amber-500/20 rounded-full"
                  />
                </div>
                <div className="flex-1 flex gap-2 overflow-hidden">
                  {[0, 1, 2].map((col) => (
                    <motion.div
                      key={col}
                      initial={{ y: 20, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      transition={{ delay: 0.2 + col * 0.15 }}
                      className="flex-1 bg-slate-50 dark:bg-slate-700/30 rounded flex flex-col gap-1 p-1"
                    >
                      <div className="h-1 w-6 bg-slate-200 dark:bg-slate-600 rounded mb-1" />
                      {[0, 1].map((card) => (
                        <div
                          key={card}
                          className="h-3 w-full bg-white dark:bg-slate-600 rounded border border-slate-100 dark:border-slate-500 shadow-sm"
                        />
                      ))}
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* --- INTERACTIVE TYPE --- */}
            {index === 3 && (
              <div className="flex flex-col h-full relative pt-1">
                {/* Browser Chrome - Padded right to avoid badge */}
                <div className="flex items-center gap-1 mb-2 border-b border-slate-100 dark:border-slate-700 pb-1 pr-10">
                  <div className="flex gap-0.5">
                    <div className="size-1.5 rounded-full bg-red-400" />
                    <div className="size-1.5 rounded-full bg-amber-400" />
                    <div className="size-1.5 rounded-full bg-green-400" />
                  </div>
                  <div className="h-1.5 flex-1 bg-slate-100 dark:bg-slate-700 rounded-full ml-1" />
                </div>

                <div className="flex-1 flex gap-2 relative">
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 }}
                    className="w-1/3 bg-slate-50 dark:bg-slate-700/30 rounded p-1 space-y-1"
                  >
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="h-1 w-full bg-slate-200 dark:bg-slate-600 rounded-full"
                      />
                    ))}
                  </motion.div>
                  <div className="flex-1 bg-emerald-50 dark:bg-emerald-900/10 rounded border border-emerald-100 dark:border-emerald-900/30 relative overflow-hidden flex items-center justify-center">
                    <Globe className="size-8 text-emerald-200 dark:text-emerald-800" />
                    <motion.div
                      className="absolute"
                      animate={{ x: [20, -10, 15, 0], y: [10, -15, 5, 0] }}
                      transition={{ duration: 3, ease: 'easeInOut' }}
                    >
                      <MousePointer2 className="size-3 text-emerald-600 fill-emerald-600" />
                    </motion.div>
                  </div>
                </div>
              </div>
            )}

            {/* Scanning beam (shared) */}
            <motion.div
              className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/30 dark:via-white/10 to-transparent -skew-x-12 pointer-events-none"
              initial={{ left: '-150%' }}
              animate={{ left: '200%' }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                repeatDelay: 1,
                ease: 'linear',
              }}
            />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// Actions: Timeline of speech, spotlight, and interactions being orchestrated
function ActionsVisualizer() {
  const [activeIdx, setActiveIdx] = useState(0);

  const actionItems = [
    {
      icon: MessageSquare,
      label: 'Speech',
      color: 'text-violet-500',
      activeBg: 'bg-violet-500/10',
      activeBorder: 'border-violet-200 dark:border-violet-800',
    },
    {
      icon: Focus,
      label: 'Spotlight',
      color: 'text-amber-500',
      activeBg: 'bg-amber-500/10',
      activeBorder: 'border-amber-200 dark:border-amber-800',
    },
    {
      icon: MessageSquare,
      label: 'Speech',
      color: 'text-violet-500',
      activeBg: 'bg-violet-500/10',
      activeBorder: 'border-violet-200 dark:border-violet-800',
    },
    {
      icon: Play,
      label: 'Interact',
      color: 'text-emerald-500',
      activeBg: 'bg-emerald-500/10',
      activeBorder: 'border-emerald-200 dark:border-emerald-800',
    },
    {
      icon: MessageSquare,
      label: 'Speech',
      color: 'text-violet-500',
      activeBg: 'bg-violet-500/10',
      activeBorder: 'border-violet-200 dark:border-violet-800',
    },
  ];

  // Row height (py-1.5 = 6px×2 padding + icon ~16px) + gap 6px ≈ 34px per row
  const ROW_H = 34;

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIdx((prev) => (prev + 1) % actionItems.length);
    }, 1600);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="size-56 relative flex items-center justify-center">
      {/* Background pulse */}
      <motion.div
        className="absolute inset-0 blur-3xl rounded-full bg-violet-500/8"
        animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 3.5, repeat: Infinity }}
      />

      {/* Timeline card */}
      <div className="w-44 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden relative">
        {/* Header */}
        <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700 flex items-center gap-2">
          <Clapperboard className="size-3 text-violet-500" />
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: '50%' }}
            transition={{ delay: 0.2 }}
            className="h-1.5 bg-violet-500/20 rounded-full"
          />
        </div>

        {/* Action items */}
        <div className="p-2 space-y-1.5 relative">
          {/* Sliding highlight — absolute, animates via y transform, no layout impact */}
          <motion.div
            className="absolute left-2 right-2 rounded-lg bg-violet-500/[0.06] dark:bg-violet-400/[0.08]"
            style={{ height: ROW_H - 6 }}
            animate={{ y: activeIdx * ROW_H }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
          />

          {actionItems.map((item, i) => {
            const Icon = item.icon;
            const isActive = i === activeIdx;
            const isPast = i < activeIdx;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: isPast ? 0.4 : 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.08, duration: 0.3 }}
                className="relative flex items-center gap-2 px-2 py-1.5 rounded-lg"
              >
                <div
                  className={cn(
                    'size-4 rounded flex items-center justify-center shrink-0 transition-colors duration-300',
                    isActive ? item.color : 'text-slate-300 dark:text-slate-600',
                  )}
                >
                  <Icon className="size-3" />
                </div>
                <div className="flex-1 flex items-center gap-1.5">
                  <span
                    className={cn(
                      'text-[8px] font-semibold uppercase tracking-wider transition-colors duration-300',
                      isActive ? item.color : 'text-slate-400 dark:text-slate-500',
                    )}
                  >
                    {item.label}
                  </span>
                  <div
                    className={cn(
                      'h-1 flex-1 rounded-full transition-colors duration-300',
                      isActive ? 'bg-current opacity-20' : 'bg-slate-100 dark:bg-slate-700',
                    )}
                  />
                </div>
                {/* Pulsing dot — always rendered, opacity-controlled, no layout shift */}
                <motion.div
                  className="size-1.5 rounded-full bg-violet-500"
                  animate={{ opacity: isActive ? [1, 0.3, 1] : 0 }}
                  transition={isActive ? { duration: 0.8, repeat: Infinity } : { duration: 0.2 }}
                />
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
