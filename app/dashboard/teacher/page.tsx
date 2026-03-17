/**
 * Teacher Dashboard
 *
 * Features: all courses/modules at a glance, live classroom controls,
 * student analytics, one-click publishing.
 */

import Link from 'next/link';

export default function TeacherDashboardPage() {
  return (
    <div className="p-6 lg:p-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Teacher Dashboard</h1>
          <p className="text-muted-foreground">Manage your courses and classrooms</p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Create Lesson
        </Link>
      </header>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* My Courses */}
        <div className="col-span-full rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">My Courses</h2>
          <p className="text-sm text-muted-foreground">
            No courses created yet. Click &quot;Create Lesson&quot; to get started.
          </p>
        </div>

        {/* Student Analytics */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Student Analytics</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total Students</span>
              <span className="text-2xl font-bold">0</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Active Today</span>
              <span className="text-2xl font-bold">0</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Avg. Completion</span>
              <span className="text-2xl font-bold">0%</span>
            </div>
          </div>
        </div>

        {/* Live Classrooms */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Live Classrooms</h2>
          <p className="text-sm text-muted-foreground">No active classrooms</p>
        </div>

        {/* Quick Actions */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Quick Actions</h2>
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
              <button
                type="button"
                className="block w-full rounded-lg border border-border p-3 text-left text-sm hover:bg-accent"
              >
                Import existing course
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
