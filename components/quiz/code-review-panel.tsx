'use client';

import type { CodeReviewResult } from '@/lib/quiz/types';

export function CodeReviewPanel({ reviews }: { reviews: Array<{ id: string; title: string; review: CodeReviewResult }> }) {
  return (
    <div className="space-y-4">
      {reviews.map((item) => (
        <div key={item.id} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <h3 className="text-lg font-semibold">{item.title}</h3>
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
          {item.review.cleanerVersion ? (
            <pre className="mt-4 overflow-x-auto rounded-xl bg-gray-950 p-4 text-xs text-gray-100">{item.review.cleanerVersion}</pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}
