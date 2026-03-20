'use client';

import type { InterviewTurn } from '@/lib/interview/types';

export function InterviewFeedbackCard({ turn }: { turn?: InterviewTurn }) {
  if (!turn?.feedback) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h3 className="text-base font-semibold">Live Feedback</h3>
        <p className="mt-3 text-sm text-muted-foreground">Answer a question to get instant AI feedback.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h3 className="text-base font-semibold">Live Feedback</h3>
      <div className="mt-4 grid gap-4">
        <div>
          <p className="text-sm font-semibold text-emerald-600">What was good</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {turn.feedback.good.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-amber-600">What was missing</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {turn.feedback.missing.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-violet-600">What a strong answer looks like</p>
          <p className="mt-2 text-sm text-muted-foreground">{turn.feedback.strongAnswer}</p>
        </div>
      </div>
    </div>
  );
}
