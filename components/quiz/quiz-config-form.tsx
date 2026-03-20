'use client';

export function QuizConfigForm({ title, description, children, onStart, loading }: { title: string; description: string; children: React.ReactNode; onStart: () => void; loading?: boolean }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6 space-y-4">{children}</div>
      <button
        onClick={onStart}
        disabled={loading}
        className="mt-6 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-60"
      >
        {loading ? 'Generating...' : 'Start Quiz'}
      </button>
    </div>
  );
}
