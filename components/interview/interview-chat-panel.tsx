'use client';

import type { InterviewTurn } from '@/lib/interview/types';

export function InterviewChatPanel({ turns }: { turns: InterviewTurn[] }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h3 className="text-base font-semibold">Interview Flow</h3>
      <div className="mt-4 space-y-4">
        {turns.map((turn, index) => (
          <div key={turn.id} className="rounded-xl border border-gray-100 p-4 dark:border-gray-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">Question {index + 1}</p>
            <p className="mt-1 text-sm font-medium">{turn.question}</p>
            {turn.answer ? <p className="mt-3 text-sm text-gray-700 dark:text-gray-300"><strong>Your answer:</strong> {turn.answer}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
