'use client';

import { motion } from 'motion/react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LetterGrade } from '@/lib/utils/grading';

interface CertificateCardProps {
  studentName: string;
  courseName: string;
  grade: LetterGrade;
  score: number;
  date: string;
  topics: string[];
  breakdown?: {
    completion: number;
    quiz: number;
    engagement: number;
  };
  isPublic?: boolean;
}

export function CertificateCard({
  studentName,
  courseName,
  grade,
  score,
  date,
  topics,
  breakdown,
  isPublic = false,
}: CertificateCardProps) {
  return (
    <div className="relative group perspective-1000 print:bg-white w-full h-full flex flex-col print:aspect-[1.414/1]">
      {/* Premium Border container */}
      <div 
        className="relative flex-1 p-[1px] md:p-[2px] rounded-[16px] md:rounded-[32px] bg-gradient-to-br from-violet-500 via-purple-500 to-indigo-500 shadow-2xl overflow-hidden"
        style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' } as any}
      >
        {/* Glass Content */}
        <div className="relative h-full w-full bg-white/95 dark:bg-slate-900/95 backdrop-blur-3xl rounded-[15px] md:rounded-[31px] p-6 md:p-10 flex flex-col items-center text-center overflow-hidden min-h-[480px] md:min-h-[520px]">
          
          {/* Background Decorative Elements */}
          <div className="absolute top-0 left-0 w-full h-full pointer-events-none">
            <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-violet-200/20 dark:bg-violet-900/10 rounded-full blur-[80px]" />
            <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-indigo-200/20 dark:bg-indigo-900/10 rounded-full blur-[80px]" />
            <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]" 
                 style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          </div>

          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="z-10 flex flex-col items-center gap-3"
          >
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-violet-600/10 text-violet-600 dark:text-violet-400 text-[10px] font-bold tracking-[0.2em] uppercase border border-violet-200/50 dark:border-violet-700/50">
              <Star className="w-2.5 h-2.5 fill-current" />
              Slate Academy Verified
              <Star className="w-2.5 h-2.5 fill-current" />
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-slate-900 dark:text-white tracking-[0.15em] leading-none">
              CERTIFICATE OF COMPLETION
            </h1>
          </motion.div>

          <div className="w-16 md:w-24 h-1 bg-gradient-to-r from-transparent via-violet-500 to-transparent my-3 md:my-5 opacity-50 shrink-0" />

          {/* Recipient */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="z-10 mt-2 md:mt-3"
          >
            <p className="text-slate-500 dark:text-slate-400 font-bold text-[10px] md:text-xs uppercase tracking-widest mb-2">This hereby certifies that</p>
            <h2 className="text-3xl md:text-5xl font-serif italic text-violet-600 dark:text-gray-100 drop-shadow-sm mb-4">
              {studentName || 'Valued Student'}
            </h2>
            <p className="max-w-[400px] md:max-w-[500px] text-xs md:text-sm text-slate-500 font-medium leading-relaxed mx-auto italic">
              has successfully mastered the concepts and applications of
            </p>
            <h3 className="text-xl md:text-2xl font-black text-slate-900 dark:text-white mt-3 md:mt-4 tracking-tight line-clamp-2 max-w-3xl mx-auto px-4">
              {courseName}
            </h3>
          </motion.div>

          {/* Results: grade, mastery bar, breakdown — one grouped panel */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 }}
            className="mt-4 md:mt-6 w-full max-w-2xl z-10 mx-auto rounded-2xl border border-slate-200/70 dark:border-slate-700/60 bg-slate-50/70 dark:bg-slate-800/35 p-4 md:p-5 text-left space-y-4"
          >
            <div className="flex flex-wrap items-end justify-between gap-4 gap-y-2">
              <div>
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                  Final grade
                </p>
                <p className="mt-0.5 text-3xl md:text-4xl font-black tracking-tight text-violet-700 dark:text-violet-300 tabular-nums">
                  {grade}
                </p>
              </div>
              <div className="text-right sm:text-left min-w-[7rem]">
                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                  Mastery level
                </p>
                <div className="mt-0.5 flex items-baseline justify-end sm:justify-start gap-1">
                  <span className="text-2xl md:text-3xl font-black text-slate-900 dark:text-white tabular-nums tracking-tight">
                    {score}
                  </span>
                  <span className="text-xs font-semibold text-slate-400">/ 100</span>
                </div>
              </div>
            </div>

            <div className="pt-1">
              <div className="h-2.5 w-full rounded-full bg-slate-200/90 dark:bg-slate-700/80 overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(score, 100)}%` }}
                  transition={{ duration: 0.85, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
                  className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 dark:from-violet-400 dark:to-indigo-400"
                />
              </div>
            </div>

            {breakdown && (
              <div className="grid grid-cols-3 gap-2 md:gap-3 pt-1 border-t border-slate-200/60 dark:border-slate-700/50">
                {[
                  { label: 'Completion', val: Math.min(breakdown.completion, 100), color: 'bg-emerald-500' },
                  { label: 'Quiz Avg', val: Math.min(breakdown.quiz, 100), color: 'bg-blue-500' },
                  { label: 'Engagement', val: Math.min(breakdown.engagement, 100), color: 'bg-purple-500' },
                ].map((item, idx) => (
                  <div
                    key={idx}
                    className="rounded-xl bg-white/80 dark:bg-slate-900/40 p-2 md:p-2.5 border border-slate-200/50 dark:border-slate-700/40"
                  >
                    <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wider block truncate">
                      {item.label}
                    </span>
                    <span className="mt-1 block text-sm font-black text-slate-900 dark:text-white tabular-nums">
                      {item.val}%
                    </span>
                    <div className="mt-1.5 h-1 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                      <div style={{ width: `${item.val}%` }} className={cn('h-full rounded-full', item.color)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>

          {/* Footer - Signatures */}
          <div className="mt-auto pt-5 md:pt-8 w-full flex items-center justify-between gap-4 md:gap-8 z-10 border-t border-slate-100 dark:border-slate-800/50">
            <div className="text-left">
              <p className="text-[10px] md:text-xs text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Issue Date</p>
              <p className="text-xs md:text-sm font-bold text-slate-700 dark:text-slate-300">{date}</p>
            </div>
            
            <div className="flex items-center gap-4 md:gap-8">
               <div className="text-center relative flex flex-col items-center">
                  <div className="absolute bottom-5 left-1/2 -translate-x-1/2 w-32 md:w-48 h-20 pointer-events-none flex items-end justify-center">
                     <img src="/signature.png" alt="Director Signature" className="object-contain w-full h-full -rotate-2 mix-blend-multiply dark:invert dark:mix-blend-screen opacity-80 relative z-20" />
                  </div>
                  <div className="h-px w-24 md:w-32 bg-slate-400/30 dark:bg-slate-500/50 mb-1.5 z-10" />
                  <p className="text-[8px] md:text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-tight">Director of Slate</p>
               </div>
            </div>
          </div>

          {/* Holographic Foil Mask */}
          <div className="absolute inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.05] bg-gradient-to-tr from-transparent via-white to-transparent mix-blend-overlay" />
        </div>
      </div>
    </div>
  );
}
