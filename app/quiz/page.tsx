import { QuizDashboard } from '@/components/quiz/quiz-dashboard';

export default function QuizPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-stone-50 via-white to-slate-100 px-4 py-10 dark:from-gray-950 dark:via-gray-950 dark:to-slate-950 md:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-600 dark:text-slate-300">Quiz Mode</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-gray-950 dark:text-gray-100">Placement + Coding Practice</h1>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground md:text-base">
            Practice company-style aptitude rounds or timed coding examinations without creating a classroom first.
          </p>
        </div>
        <QuizDashboard />
      </div>
    </main>
  );
}
