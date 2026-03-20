'use client';

import type { CodeReviewResult } from '@/lib/quiz/types';

export function CodeReviewPanel({ reviews }: { reviews: Array<{ id: string; title: string; review: CodeReviewResult }> }) {
  return (
    <div className="space-y-4">
      {reviews.map((item) => {
        const passed = item.review.verdict === 'pass';
        return (
          <div key={item.id} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${passed ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                {passed ? 'Pass' : 'Fail'} · {item.review.score ?? '—'}/10
              </span>
            </div>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{item.review.summary}</p>
            {item.review.missingPoints?.length > 0 ? (
              <div className="mt-3">
                <h4 className="text-sm font-semibold text-red-600 dark:text-red-400">Missing / Incorrect</h4>
                <ul className="mt-1 list-disc pl-4 text-sm text-muted-foreground">
                  {item.review.missingPoints.map((point, i) => <li key={i}>{point}</li>)}
                </ul>
              </div>
            ) : null}
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
            {item.review.cleanerVersion ? (
              <pre className="mt-4 overflow-x-auto rounded-xl bg-gray-950 p-4 text-xs text-gray-100">{item.review.cleanerVersion}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
