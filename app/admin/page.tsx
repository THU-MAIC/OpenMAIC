import { prisma } from '@/lib/auth/prisma';
import Link from 'next/link';
import { Users, ScrollText, BookOpen } from 'lucide-react';
import { hasAnyServerPermission } from '@/lib/auth/helpers';
import { redirect } from 'next/navigation';
import { I18nText } from '@/components/i18n-text';

export default async function AdminDashboardPage() {
  const canViewDashboard = await hasAnyServerPermission('view_users', 'view_own_classrooms', 'view_invited_classrooms', 'view_audit_logs');
  if (!canViewDashboard) {
    redirect('/admin/system-config');
  }

  const [totalUsers, totalStudents, totalInstructors, recentAudit] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: 'STUDENT' } }),
    prisma.user.count({ where: { role: 'INSTRUCTOR' } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 5, include: { actor: { select: { name: true, email: true } } } }),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-6"><I18nText k="adminDashboard.title" fallback="Dashboard" /></h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <Link
          href="/admin/users"
          className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-5 hover:bg-slate-50 dark:hover:bg-white/8 transition-colors"
        >
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-5 h-5 text-purple-400" />
            <span className="text-slate-500 dark:text-slate-400 text-sm"><I18nText k="adminDashboard.totalUsers" fallback="Total Users" /></span>
          </div>
          <p className="text-3xl font-bold text-slate-900 dark:text-white">{totalUsers}</p>
        </Link>
        <Link
          href="/admin/users?role=STUDENT"
          className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-5 hover:bg-slate-50 dark:hover:bg-white/8 transition-colors"
        >
          <div className="flex items-center gap-3 mb-2">
            <BookOpen className="w-5 h-5 text-blue-400" />
            <span className="text-slate-500 dark:text-slate-400 text-sm"><I18nText k="adminDashboard.students" fallback="Students" /></span>
          </div>
          <p className="text-3xl font-bold text-slate-900 dark:text-white">{totalStudents}</p>
        </Link>
        <Link
          href="/admin/users?role=INSTRUCTOR"
          className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-5 hover:bg-slate-50 dark:hover:bg-white/8 transition-colors"
        >
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-5 h-5 text-emerald-400" />
            <span className="text-slate-500 dark:text-slate-400 text-sm"><I18nText k="adminDashboard.instructors" fallback="Instructors" /></span>
          </div>
          <p className="text-3xl font-bold text-slate-900 dark:text-white">{totalInstructors}</p>
        </Link>
      </div>

      <div className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 className="text-slate-900 dark:text-white font-semibold flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-slate-500 dark:text-slate-400" /> <I18nText k="adminDashboard.recentActivity" fallback="Recent Activity" />
          </h2>
          <Link href="/admin/audit-log" className="text-purple-400 hover:text-purple-300 text-sm">
            <I18nText k="adminDashboard.viewAll" fallback="View all" /> →
          </Link>
        </div>
        {recentAudit.length === 0 ? (
          <p className="text-slate-400 dark:text-slate-500 text-sm"><I18nText k="adminDashboard.noActivity" fallback="No activity yet." /></p>
        ) : (
          <div className="space-y-2">
            {recentAudit.map((log) => (
              <div key={log.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-100 dark:border-white/5 last:border-0">
                <div className="min-w-0 mr-2">
                  <span className="text-slate-900 dark:text-white font-medium">{log.actor?.name ?? log.actor?.email ?? <I18nText k="adminDashboard.system" fallback="System" />}</span>
                  <span className="text-slate-500 dark:text-slate-400 ml-2">{log.action}</span>
                  {log.resource && <span className="text-slate-400 dark:text-slate-500 ml-1 text-xs">({log.resource})</span>}
                </div>
                <span className="text-slate-400 dark:text-slate-500 text-xs">{new Date(log.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
