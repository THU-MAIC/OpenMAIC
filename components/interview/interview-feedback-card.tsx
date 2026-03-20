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

  const good = Array.isArray(turn.feedback.good) ? turn.feedback.good : [];
  const missing = Array.isArray(turn.feedback.missing) ? turn.feedback.missing : [];
  const strongAnswer = turn.feedback.strongAnswer || 'No sample answer available yet.';

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h3 className="text-base font-semibold">Live Feedback</h3>
      <div className="mt-4 grid gap-4">
        <div>
          <p className="text-sm font-semibold text-emerald-600">What was good</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {good.length > 0 ? good.map((item) => <li key={item}>{item}</li>) : <li>No clear strengths identified yet.</li>}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-amber-600">What was missing</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {missing.length > 0 ? missing.map((item) => <li key={item}>{item}</li>) : <li>No major gaps identified.</li>}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">What a strong answer looks like</p>
          <p className="mt-2 text-sm text-muted-foreground">{strongAnswer}</p>
        </div>
      </div>
    </div>
  );
}
