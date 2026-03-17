/**
 * Dashboard Router
 *
 * Redirects users to their role-specific dashboard.
 * Default: student dashboard (most common role).
 */
import { redirect } from 'next/navigation';

export default function DashboardPage() {
  // TODO: Read user role from auth context and redirect accordingly
  redirect('/dashboard/student');
}
