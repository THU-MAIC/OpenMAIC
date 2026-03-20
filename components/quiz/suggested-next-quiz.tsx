'use client';

export function SuggestedNextQuiz({ suggestion }: { suggestion: { title: string; description: string } }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5 dark:border-amber-900/60 dark:bg-amber-950/20">
      <h3 className="text-base font-semibold text-amber-900 dark:text-amber-200">Suggested Next Quiz</h3>
      <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-300">{suggestion.title}</p>
      <p className="mt-1 text-sm text-amber-800/80 dark:text-amber-300/80">{suggestion.description}</p>
    </div>
  );
}
