'use client';

import type { InterviewSessionSummary } from '@/lib/interview/types';

export function InterviewSummary({ summary }: { summary: InterviewSessionSummary }) {
  return (
    <div className="rounded-2xl border border-violet-200 bg-violet-50 p-6 dark:border-violet-800 dark:bg-violet-950/30">
      <h3 className="text-xl font-semibold text-violet-900 dark:text-violet-200">Final Debrief</h3>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl bg-white/80 p-4 dark:bg-gray-900/60">
          <p className="text-sm text-muted-foreground">Overall Score</p>
          <p className="mt-1 text-3xl font-black">{summary.overallScore}</p>
        </div>
        <div className="rounded-xl bg-white/80 p-4 dark:bg-gray-900/60">
          <p className="text-sm text-muted-foreground">Communication</p>
          <p className="mt-1 text-3xl font-black">{summary.communicationRating}/10</p>
        </div>
        <div className="rounded-xl bg-white/80 p-4 dark:bg-gray-900/60">
          <p className="text-sm text-muted-foreground">Technical Accuracy</p>
          <p className="mt-1 text-3xl font-black">{summary.technicalAccuracyRating}/10</p>
        </div>
      </div>
      <p className="mt-4 text-sm text-violet-900/80 dark:text-violet-200/80">{summary.summary}</p>
      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-violet-900/80 dark:text-violet-200/80">
        {summary.topImprovements.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}
