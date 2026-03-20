'use client';

import type { CodeReviewResult } from '@/lib/quiz/types';

export function CodeReviewPanel({ reviews }: { reviews: Array<{ id: string; title: string; review: CodeReviewResult }> }) {
  return (
    <div className="space-y-4">
      {reviews.map((item) => (
        <div key={item.id} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">{item.title}</h3>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                {item.review.score}/100
              </span>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  item.review.verdict === 'strong'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : item.review.verdict === 'partial'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                      : 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                }`}
              >
                {item.review.verdict}
              </span>
            </div>
          </div>
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{item.review.summary}</p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold">Optimal Approach</h4>
              <p className="mt-1 text-sm text-muted-foreground">{item.review.optimalApproach}</p>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Complexity</h4>
              <p className="mt-1 text-sm text-muted-foreground">Time: {item.review.timeComplexity}</p>
              <p className="text-sm text-muted-foreground">Space: {item.review.spaceComplexity}</p>
            </div>
          </div>
          {item.review.missingPoints.length > 0 ? (
            <div className="mt-4">
              <h4 className="text-sm font-semibold">Missing / Incorrect</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {item.review.missingPoints.map((point) => <li key={point}>{point}</li>)}
              </ul>
            </div>
          ) : null}
          {item.review.cleanerVersion ? (
            <pre className="mt-4 overflow-x-auto rounded-xl bg-gray-950 p-4 text-xs text-gray-100">{item.review.cleanerVersion}</pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}
