import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Users, LayoutDashboard, ScrollText, GraduationCap, LogOut, LibraryBig, Settings, Shield } from 'lucide-react';
import { signOut } from '@/lib/auth/auth';
import { DevServerControls } from '@/components/admin/dev-server-controls';
import { auth } from '@/lib/auth/auth';
import { MobileAdminNav } from '@/components/admin/mobile-nav';
import { I18nText } from '@/components/i18n-text';
import { QuickPreferencesBar } from '@/components/quick-preferences-bar';
import { hasAnyServerPermission, hasServerPermission } from '@/lib/auth/helpers';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/');

  const [
    canAccessAdmin,
    canViewUsers,
    canViewRoles,
    canViewClassrooms,
    canViewAuditLog,
    canManageSystemConfig,
    canViewPrompts,
    canViewDashboard,
  ] = await Promise.all([
    hasAnyServerPermission(
      'view_users',
      'view_roles',
      'view_own_classrooms',
      'view_invited_classrooms',
      'view_audit_logs',
      'manage_system_config',
      'view_prompts',
    ),
    hasServerPermission('view_users'),
    hasServerPermission('view_roles'),
    hasAnyServerPermission('view_own_classrooms', 'view_invited_classrooms'),
    hasServerPermission('view_audit_logs'),
    hasServerPermission('manage_system_config'),
    hasServerPermission('view_prompts'),
    hasAnyServerPermission('view_users', 'view_own_classrooms', 'view_invited_classrooms', 'view_audit_logs'),
  ]);

  if (!canAccessAdmin) redirect('/');

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col">
      <MobileAdminNav
        userName={session.user.name ?? ''}
        userEmail={session.user.email ?? ''}
        canViewDashboard={canViewDashboard}
        canViewUsers={canViewUsers}
        canViewRoles={canViewRoles}
        canViewClassrooms={canViewClassrooms}
        canManageSystemConfig={canManageSystemConfig}
        canViewPrompts={canViewPrompts}
        canViewAuditLog={canViewAuditLog}
      />
      <div className="flex flex-1">
      {/* Sidebar — desktop only */}
      <nav className="hidden md:flex w-56 flex-shrink-0 bg-white/80 dark:bg-slate-800/60 border-r border-slate-200 dark:border-white/5 flex-col">
        <div className="p-5 border-b border-slate-200 dark:border-white/5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center flex-shrink-0">
              <GraduationCap className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-slate-900 dark:text-white font-semibold text-sm leading-tight">MU-OpenMAIC</p>
              <p className="text-slate-500 dark:text-slate-400 text-xs"><I18nText k="adminNav.panel" fallback="Admin Panel" /></p>
            </div>
          </div>
        </div>

        <div className="flex-1 py-4 px-3 space-y-3">
          {canViewDashboard && (
            <div>
              <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-500"><I18nText k="adminNav.overview" fallback="Overview" /></p>
              <NavLink href="/admin" icon={<LayoutDashboard className="w-4 h-4" />} label={<I18nText k="adminNav.dashboard" fallback="Dashboard" />} />
            </div>
          )}
          {(canViewUsers || canViewRoles || canViewClassrooms) && (
            <div>
              <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-500"><I18nText k="adminNav.management" fallback="Management" /></p>
              {canViewUsers && <NavLink href="/admin/users" icon={<Users className="w-4 h-4" />} label={<I18nText k="adminNav.users" fallback="Users" />} />}
              {canViewRoles && <NavLink href="/admin/roles" icon={<Shield className="w-4 h-4" />} label={<I18nText k="adminNav.roles" fallback="Roles" />} />}
              {canViewClassrooms && <NavLink href="/admin/classrooms" icon={<LibraryBig className="w-4 h-4" />} label={<I18nText k="adminNav.classrooms" fallback="Classrooms" />} />}
            </div>
          )}
          {(canManageSystemConfig || canViewPrompts || canViewAuditLog) && (
            <div>
              <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-500"><I18nText k="adminNav.governance" fallback="Governance" /></p>
              {canManageSystemConfig && <NavLink href="/admin/system-config/settings" icon={<Settings className="w-4 h-4" />} label={<I18nText k="adminNav.generalSettings" fallback="General settings" />} />}
              {canViewPrompts && <NavLink href="/admin/system-config/prompts" icon={<Settings className="w-4 h-4" />} label={<I18nText k="adminNav.promptStudio" fallback="Prompt studio" />} />}
              {canViewAuditLog && <NavLink href="/admin/audit-log" icon={<ScrollText className="w-4 h-4" />} label={<I18nText k="adminNav.auditLog" fallback="Audit Log" />} />}
            </div>
          )}

          <div>
            <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-500"><I18nText k="adminNav.account" fallback="Account" /></p>
            <div className="px-3 py-2 mb-2">
              <p className="text-slate-700 dark:text-slate-200 text-xs font-medium truncate">{session.user.name}</p>
              <p className="text-slate-500 text-xs truncate">{session.user.email}</p>
            </div>

            <div className="mb-2 border-t border-slate-200 dark:border-white/5 pt-2">
              <DevServerControls />
            </div>

            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/auth/signin' });
              }}
            >
              <button
                type="submit"
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 text-sm transition-colors"
              >
                <LogOut className="w-4 h-4" /> <I18nText k="adminNav.signOut" fallback="Sign out" />
              </button>
            </form>
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-4 pt-[4.5rem] md:p-8 md:pt-8">
        <div className="mb-4 md:mb-6">
          <QuickPreferencesBar />
        </div>
        {children}
      </main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 text-sm transition-colors"
    >
      {icon} {label}
    </Link>
  );
}
