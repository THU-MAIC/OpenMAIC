import { InterviewDashboard } from '@/components/interview/interview-dashboard';

export default function InterviewPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-fuchsia-50/40 px-4 py-10 dark:from-gray-950 dark:to-gray-950 md:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-fuchsia-600">Interview Prep</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-gray-950 dark:text-gray-100">Realistic Interview Simulation</h1>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground md:text-base">
            Practice technical and HR rounds with a natural AI interviewer, live feedback, voice input, and final coaching.
          </p>
        </div>
        <InterviewDashboard />
      </div>
    </main>
  );
}
