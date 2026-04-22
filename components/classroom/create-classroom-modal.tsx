'use client';

import { motion, AnimatePresence } from 'motion/react';
import { X, BookOpen } from 'lucide-react';

interface Props {
  open: boolean;
  requirement: string;
  onClose: () => void;
}

const STEPS = [
  'Researching your topic',
  'Designing scene outlines',
  'Generating interactive scenes',
  'Creating audio narration',
  'Saving your classroom',
];

export function CreateClassroomModal({ open, requirement, onClose }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.92, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            className="fixed inset-0 z-[90] flex items-center justify-center p-4 pointer-events-none"
          >
            <div
              className="pointer-events-auto w-full max-w-lg bg-white dark:bg-slate-900 rounded-3xl border-[3px] border-[#073b4c] shadow-[10px_10px_0_#073b4c] overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close button */}
              <div className="flex justify-end px-5 pt-5">
                <button
                  type="button"
                  onClick={onClose}
                  className="size-8 rounded-full flex items-center justify-center text-[#073b4c]/50 hover:bg-[#073b4c]/10 transition-colors"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="px-8 pb-10 pt-2 flex flex-col items-center text-center">
                {/* Animated spinner */}
                <div className="relative mb-8">
                  <div className="size-24 rounded-full border-4 border-[#073b4c]/10 flex items-center justify-center">
                    <BookOpen className="size-10 text-[#073b4c]/30" />
                  </div>
                  {/* Outer spinning ring */}
                  <svg
                    className="absolute inset-0 size-24 animate-spin"
                    style={{ animationDuration: '2s' }}
                    viewBox="0 0 96 96"
                    fill="none"
                  >
                    <circle
                      cx="48"
                      cy="48"
                      r="44"
                      stroke="#ef476f"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeDasharray="70 208"
                    />
                  </svg>
                  {/* Inner spinning ring (opposite) */}
                  <svg
                    className="absolute inset-[8px] size-20 animate-spin"
                    style={{ animationDuration: '3s', animationDirection: 'reverse' }}
                    viewBox="0 0 80 80"
                    fill="none"
                  >
                    <circle
                      cx="40"
                      cy="40"
                      r="36"
                      stroke="#06d6a0"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeDasharray="40 186"
                    />
                  </svg>
                </div>

                <h2 className="text-2xl font-black text-[#073b4c] mb-2">
                  Creating Your Classroom
                </h2>

                {requirement && (
                  <p className="text-sm font-medium text-[#073b4c]/60 mb-4 max-w-sm line-clamp-2">
                    &ldquo;{requirement}&rdquo;
                  </p>
                )}

                <p className="text-base text-[#073b4c]/80 font-medium mb-2">
                  Your AI-powered classroom is being generated.
                </p>
                <p className="text-sm text-[#073b4c]/50 mb-8">
                  This typically takes <span className="font-bold text-[#073b4c]/70">3–5 minutes</span>. Feel free to close this and we&apos;ll notify you the moment it&apos;s ready.
                </p>

                {/* Step list */}
                <div className="w-full bg-[#f0f4f8] dark:bg-slate-800/50 rounded-2xl p-4 mb-8 text-left space-y-2">
                  {STEPS.map((step, i) => (
                    <div key={step} className="flex items-center gap-3">
                      <div className="size-5 rounded-full border-2 border-[#073b4c]/20 flex items-center justify-center shrink-0">
                        <div
                          className="size-2 rounded-full bg-[#ef476f] animate-pulse"
                          style={{ animationDelay: `${i * 0.4}s` }}
                        />
                      </div>
                      <span className="text-xs font-medium text-[#073b4c]/70">{step}</span>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  className="w-full h-12 rounded-2xl border-[3px] border-[#073b4c] bg-[#073b4c] text-white font-black text-sm hover:bg-[#073b4c]/90 shadow-[4px_4px_0_#ef476f] hover:shadow-[6px_6px_0_#ef476f] hover:translate-y-[-2px] transition-all"
                >
                  Close &amp; notify me when ready
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
