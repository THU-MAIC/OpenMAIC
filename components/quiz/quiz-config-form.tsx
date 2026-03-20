'use client';

export function QuizConfigForm({ title, description, children, onStart, loading }: { title: string; description: string; children: React.ReactNode; onStart: () => void; loading?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6 space-y-4">{children}</div>
      <button
        onClick={onStart}
        disabled={loading}
        className="mt-6 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
      >
        {loading ? 'Generating...' : 'Start Quiz'}
      </button>
    </div>
  );
}
