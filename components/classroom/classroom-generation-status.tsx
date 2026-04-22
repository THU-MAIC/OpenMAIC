'use client';

import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';

export type ClassroomJobPhase = 'background' | 'done';

export interface ClassroomJobState {
  jobId: string;
  requirement: string;
  phase: ClassroomJobPhase;
  classroomUrl?: string;
  courseTitle?: string;
}

interface Props {
  job: ClassroomJobState | null;
  onReopen?: () => void;
}

export function ClassroomGenerationStatus({ job, onReopen }: Props) {
  const router = useRouter();

  return (
    <AnimatePresence>
      {job && (
        <motion.div
          key={job.phase}
          initial={{ opacity: 0, y: -6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.96 }}
          transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
        >
          {job.phase === 'background' ? (
            /* Generating pill — click to reopen modal */
            <button
              type="button"
              onClick={onReopen}
              className="flex items-center gap-2 h-9 px-4 rounded-full border-2 border-[#073b4c] bg-white text-[#073b4c] shadow-[3px_3px_0_#073b4c] hover:shadow-[4px_4px_0_#073b4c] hover:translate-y-[-1px] transition-all cursor-pointer active:translate-y-0 active:shadow-[1px_1px_0_#073b4c]"
            >
              {/* Custom spinner */}
              <svg
                className="size-3.5 shrink-0 animate-spin text-[#ef476f]"
                style={{ animationDuration: '1.2s' }}
                viewBox="0 0 14 14"
                fill="none"
              >
                <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2" />
                <path
                  d="M7 1.5A5.5 5.5 0 0 1 12.5 7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <span className="text-xs font-bold truncate max-w-[180px]">
                Generating&hellip;
              </span>
              <span className="text-[10px] text-[#073b4c]/50 font-medium truncate max-w-[120px] hidden sm:block">
                {job.requirement.length > 28 ? job.requirement.slice(0, 28) + '…' : job.requirement}
              </span>
            </button>
          ) : (
            /* Completed pill */
            <motion.button
              type="button"
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              onClick={() => {
                if (job.classroomUrl) {
                  const path = (() => {
                    try {
                      return new URL(job.classroomUrl).pathname;
                    } catch {
                      return job.classroomUrl;
                    }
                  })();
                  router.push(path);
                }
              }}
              className="flex items-center gap-2 h-9 px-4 rounded-full border-2 border-[#073b4c] bg-[#06d6a0] text-[#073b4c] font-bold text-xs shadow-[3px_3px_0_#073b4c] hover:shadow-[4px_4px_0_#073b4c] hover:translate-y-[-1px] transition-all cursor-pointer active:translate-y-0 active:shadow-[1px_1px_0_#073b4c]"
            >
              <CheckCircle2 className="size-3.5 shrink-0" />
              <span className="truncate max-w-[140px]">
                {job.courseTitle || job.requirement.slice(0, 24) + (job.requirement.length > 24 ? '…' : '')}
              </span>
              <span className="text-[10px] opacity-60 hidden sm:inline">›</span>
              <span className="text-xs font-black hidden sm:inline">Enter Classroom</span>
              <ExternalLink className="size-3 shrink-0 opacity-60" />
            </motion.button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
