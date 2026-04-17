import { redirect } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap, LayoutDashboard, BookOpen, Users, ClipboardList, LogOut, Menu } from 'lucide-react';
import { auth, signOut } from '@/lib/auth/auth';
import { I18nText } from '@/components/i18n-text';
import { QuickPreferencesBar } from '@/components/quick-preferences-bar';

export default async function InstructorLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user) redirect('/auth/signin');
  if (session.user.role !== 'INSTRUCTOR' && session.user.role !== 'ADMIN') {
    redirect('/');
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col">
      <div className="flex flex-1">
        {/* Sidebar */}
        <nav className="hidden md:flex w-56 flex-shrink-0 bg-white/80 dark:bg-slate-800/60 border-r border-slate-200 dark:border-white/5 flex-col">
          <div className="p-5 border-b border-slate-200 dark:border-white/5">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center flex-shrink-0">
                <GraduationCap className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-slate-900 dark:text-white font-semibold text-sm leading-tight">OpenMAIC</p>
                <p className="text-slate-500 dark:text-slate-400 text-xs"><I18nText k="instructorNav.panel" fallback="Instructor Panel" /></p>
              </div>
            </div>
          </div>

          <div className="flex-1 py-4 px-3 space-y-3">
            <div>
              <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-500"><I18nText k="instructorNav.navigation" fallback="Navigation" /></p>
              <NavLink href="/instructor" icon={<LayoutDashboard className="w-4 h-4" />} label={<I18nText k="instructorNav.dashboard" fallback="Dashboard" />} exact />
              <NavLink href="/instructor/classrooms" icon={<BookOpen className="w-4 h-4" />} label={<I18nText k="instructorNav.classrooms" fallback="Classrooms" />} />
              <NavLink href="/instructor/students" icon={<Users className="w-4 h-4" />} label={<I18nText k="instructorNav.students" fallback="Students" />} />
              <NavLink href="/instructor/grading" icon={<ClipboardList className="w-4 h-4" />} label={<I18nText k="instructorNav.grading" fallback="Grading" />} />
            </div>

            <div>
              <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-500"><I18nText k="instructorNav.account" fallback="Account" /></p>
              <div className="mb-2 px-3 text-xs text-slate-400 truncate">{session.user.email}</div>
              <form
                action={async () => {
                  'use server';
                  await signOut({ redirectTo: '/' });
                }}
              >
                <button
                  type="submit"
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/6 hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  <I18nText k="instructorNav.signOut" fallback="Sign out" />
                </button>
              </form>
            </div>
          </div>
        </nav>

        {/* Mobile header */}
        <div className="md:hidden fixed top-0 left-0 right-0 z-20 flex items-center justify-between bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-white/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <GraduationCap className="w-5 h-5 text-indigo-400" />
            <span className="text-slate-900 dark:text-white font-semibold text-sm"><I18nText k="instructorNav.instructor" fallback="Instructor" /></span>
          </div>
          <details className="relative">
            <summary
              className="list-none rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-white/5 px-2.5 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
              aria-label="Open navigation menu"
            >
              <Menu className="w-4 h-4" />
            </summary>
            <div className="absolute right-0 mt-2 w-48 overflow-hidden rounded-xl border border-slate-200 dark:border-white/10 bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-xl">
              <div className="py-1">
                <Link href="/instructor" className="block px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white"><I18nText k="instructorNav.dashboard" fallback="Dashboard" /></Link>
                <Link href="/instructor/classrooms" className="block px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white"><I18nText k="instructorNav.classrooms" fallback="Classrooms" /></Link>
                <Link href="/instructor/students" className="block px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white"><I18nText k="instructorNav.students" fallback="Students" /></Link>
                <Link href="/instructor/grading" className="block px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white"><I18nText k="instructorNav.grading" fallback="Grading" /></Link>
              </div>
            </div>
          </details>
        </div>

        <main className="flex-1 overflow-auto p-4 pt-[4.5rem] md:p-8 md:pt-8 mt-14 md:mt-0">
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
  exact = false,
}: {
  href: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  exact?: boolean;
}) {
  // Active state is determined client-side via CSS; server renders as neutral
  return (
    <Link
      href={href}
      prefetch={false}
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/6 hover:text-slate-900 dark:hover:text-white transition-colors"
    >
      {icon}
      {label}
    </Link>
  );
}
