/**
 * Student Dashboard
 *
 * Features: progress rings, adaptive path suggestions, quick-start scenes,
 * "continue learning" cards, and recent activity.
 */

import Link from 'next/link';

export default function StudentDashboardPage() {
  return (
    <div className="p-6 lg:p-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Student Dashboard</h1>
        <p className="text-muted-foreground">Track your progress and continue learning</p>
      </header>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Continue Learning Card */}
        <div className="col-span-full rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Continue Learning</h2>
          <p className="text-sm text-muted-foreground">
            No courses enrolled yet. Start by exploring available courses.
          </p>
        </div>

        {/* Progress Overview */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Progress</h2>
          <div className="flex items-center justify-center py-8">
            <div className="relative h-32 w-32">
              <svg className="h-full w-full -rotate-90" viewBox="0 0 36 36">
                <path
                  d="M18 2.0845a 15.9155 15.9155 0 0 1 0 31.831a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted"
                />
                <path
                  d="M18 2.0845a 15.9155 15.9155 0 0 1 0 31.831a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeDasharray="0, 100"
                  className="text-primary"
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-2xl font-bold">
                0%
              </span>
            </div>
          </div>
        </div>

        {/* Quick Start */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Quick Start</h2>
          <ul className="space-y-3">
            <li>
              <Link
                href="/"
                className="block rounded-lg border border-border p-3 text-sm hover:bg-accent"
              >
                Generate a lesson with AI
              </Link>
            </li>
            <li>
              <Link
                href="/dashboard/student"
                className="block rounded-lg border border-border p-3 text-sm hover:bg-accent"
              >
                Browse courses
              </Link>
            </li>
          </ul>
        </div>

        {/* Recent Activity */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Recent Activity</h2>
          <p className="text-sm text-muted-foreground">No recent activity</p>
        </div>
      </div>
    </div>
  );
}
