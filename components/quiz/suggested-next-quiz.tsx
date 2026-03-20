'use client';

export function SuggestedNextQuiz({ suggestion }: { suggestion: { title: string; description: string } }) {
  return (
    <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5 dark:border-violet-800 dark:bg-violet-950/30">
      <h3 className="text-base font-semibold text-violet-900 dark:text-violet-200">Suggested Next Quiz</h3>
      <p className="mt-2 text-sm font-medium text-violet-800 dark:text-violet-300">{suggestion.title}</p>
      <p className="mt-1 text-sm text-violet-700/80 dark:text-violet-300/80">{suggestion.description}</p>
    </div>
  );
}
