/**
 * Dashboard Layout
 *
 * Shared layout for all role-based dashboards.
 * Provides navigation sidebar, header, and assistant bubble.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Dashboard - OpenMAIC',
  description: 'Your personalized learning dashboard',
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar navigation - to be implemented */}
      <aside className="hidden w-64 border-r border-border bg-card lg:block">
        <div className="flex h-14 items-center border-b border-border px-6">
          <span className="text-lg font-semibold">OpenMAIC</span>
        </div>
        <nav className="p-4">
          <ul className="space-y-1">
            <li>
              <Link
                href="/dashboard/student"
                className="block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Student
              </Link>
            </li>
            <li>
              <Link
                href="/dashboard/teacher"
                className="block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Teacher
              </Link>
            </li>
            <li>
              <Link
                href="/dashboard/admin"
                className="block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Admin
              </Link>
            </li>
          </ul>
        </nav>
      </aside>

      {/* Main content area */}
      <main className="flex-1">{children}</main>
    </div>
  );
}
