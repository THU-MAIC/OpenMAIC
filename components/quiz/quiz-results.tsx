'use client';

export function QuizResults({
  title,
  score,
  total,
  debrief,
  children,
}: {
  title: string;
  score: number;
  total: number;
  debrief?: { summary?: string; percentileEstimate?: string };
  children?: React.ReactNode;
}) {
  const percentage = total ? Math.round((score / total) * 100) : 0;
  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-violet-600 to-fuchsia-600 p-6 text-white shadow-lg">
        <p className="text-sm uppercase tracking-wide text-white/70">{title}</p>
        <div className="mt-2 flex items-end gap-2">
          <span className="text-4xl font-black">{score}</span>
          <span className="text-xl text-white/70">/ {total}</span>
        </div>
        <p className="mt-2 text-sm text-white/80">{percentage}%</p>
        {debrief?.percentileEstimate ? <p className="mt-1 text-sm text-white/80">{debrief.percentileEstimate}</p> : null}
      </div>
      {debrief?.summary ? (
        <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5 text-sm text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-200">
          {debrief.summary}
        </div>
      ) : null}
      {children}
    </div>
  );
}
