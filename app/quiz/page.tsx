import { QuizDashboard } from '@/components/quiz/quiz-dashboard';

export default function QuizPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-violet-50/40 px-4 py-10 dark:from-gray-950 dark:to-gray-950 md:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-600">Quiz Mode</p>
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
