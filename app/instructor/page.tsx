import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, BookOpen, Users, Calendar, ClipboardList } from 'lucide-react';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { readClassroom } from '@/lib/server/classroom-storage';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { I18nText } from '@/components/i18n-text';

export default async function InstructorDashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/auth/signin');

  // Fetch classrooms owned by this instructor (owner marker: userId === assignedBy)
  const ownedAccess = await prisma.classroomAccess.findMany({
    where: {
      userId: session.user.id,
      assignedBy: session.user.id,
    },
    orderBy: { assignedAt: 'desc' },
    take: 100,
  });

  // Resolve file data for each owned classroom (limit 20 for perf)
  const recentIds = ownedAccess.slice(0, 20).map((a) => a.classroomId);
  const classroomData = await Promise.all(
    recentIds.map(async (id) => {
      try {
        return await readClassroom(id);
      } catch {
        return null;
      }
    }),
  );

  const resolved = classroomData.filter(Boolean);
  const totalClassrooms = ownedAccess.length;

  // Count total enrolled students across owned classrooms
  const studentCountResult = await prisma.classroomAccess.count({
    where: {
      classroomId: { in: ownedAccess.map((a) => a.classroomId) },
      NOT: { userId: session.user.id },
    },
  });

  const recent5 = resolved.slice(0, 5);

  // Fetch per-classroom student counts (exclude owner row)
  const perClassroomCounts = await Promise.all(
    recent5.map(async (c) => {
      if (!c) return 0;
      return prisma.classroomAccess.count({
        where: { classroomId: c.id, NOT: { userId: session.user.id } },
      });
    }),
  );

  const taskMenu = [
    {
      titleKey: 'instructorDashboard.taskDashboard',
      titleFallback: 'Dashboard',
      href: '/instructor',
      icon: <Calendar className="w-5 h-5 text-amber-400" />,
    },
    {
      titleKey: 'instructorDashboard.taskClassroomManagement',
      titleFallback: 'Classroom Management',
      href: '/instructor/classrooms',
      icon: <BookOpen className="w-5 h-5 text-indigo-400" />,
    },
    {
      titleKey: 'instructorDashboard.taskStudentManagement',
      titleFallback: 'Student Management',
      href: '/instructor/students',
      icon: <Users className="w-5 h-5 text-emerald-400" />,
    },
    {
      titleKey: 'instructorDashboard.taskGradingManagement',
      titleFallback: 'Grading Management',
      href: '/instructor/grading',
      icon: <ClipboardList className="w-5 h-5 text-violet-400" />,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white"><I18nText k="instructorDashboard.title" fallback="Dashboard" /></h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            <I18nText k="instructorDashboard.welcomeBack" fallback="Welcome back," /> {session.user.name ?? session.user.email}
          </p>
        </div>
        <Link
          href="/instructor/classrooms/new/step/basics"
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <I18nText k="instructorDashboard.createClassroom" fallback="Create Classroom" />
        </Link>
      </div>

      <section className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-indigo-200"><I18nText k="instructorDashboard.taskMenu" fallback="Task Menu" /></h2>
        <p className="mt-1 text-sm text-indigo-100/80"><I18nText k="instructorDashboard.taskMenuDescription" fallback="Choose your next instructor workflow." /></p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {taskMenu.map((task) => (
            <Link
              key={task.titleKey}
              href={task.href}
              className="rounded-lg border border-white/10 bg-slate-900/40 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-900/60 hover:text-white"
            >
              <I18nText k={task.titleKey} fallback={task.titleFallback} />
            </Link>
          ))}
        </div>
      </section>

      {/* Stats row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<BookOpen className="w-5 h-5 text-indigo-400" />}
          label={<I18nText k="instructorDashboard.totalClassrooms" fallback="Total Classrooms" />}
          value={String(totalClassrooms)}
        />
        <StatCard
          icon={<Users className="w-5 h-5 text-emerald-400" />}
          label={<I18nText k="instructorDashboard.totalStudents" fallback="Total Students" />}
          value={String(studentCountResult)}
        />
        <StatCard
          icon={<Calendar className="w-5 h-5 text-amber-400" />}
          label={<I18nText k="instructorDashboard.pendingReviews" fallback="Pending Reviews" />}
          value="0"
        />
      </div>

      {/* Recent classrooms */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white"><I18nText k="instructorDashboard.recentClassrooms" fallback="Recent Classrooms" /></h2>
          <Link
            href="/instructor/classrooms"
            className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            <I18nText k="instructorDashboard.viewAll" fallback="View all" />
          </Link>
        </div>

        {recent5.length === 0 ? (
          <EmptyState
            title={<I18nText k="instructorDashboard.noClassrooms" fallback="No classrooms yet" />}
            description={<I18nText k="instructorDashboard.noClassroomsDesc" fallback="Create your first classroom to get started." />}
            icon={<BookOpen className="w-5 h-5" />}
          />
        ) : (
          <div className="space-y-3">
            {recent5.map((classroom, idx) => {
              if (!classroom) return null;
              return (
                <ClassroomCard
                  key={classroom.id}
                  id={classroom.id}
                  title={classroom.stage.name || classroom.id}
                  sceneCount={classroom.scenes.length}
                  createdAt={classroom.createdAt}
                  studentCount={perClassroomCounts[idx] ?? 0}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  value: string;
}) {
  return (
        <div className="rounded-xl border border-white/10 bg-white dark:bg-white/5 p-5 flex items-center gap-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/8">
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold text-slate-900 dark:text-white">{value}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      </div>
    </div>
  );
}

function ClassroomCard({
  id,
  title,
  sceneCount,
  createdAt,
  studentCount,
}: {
  id: string;
  title: string;
  sceneCount: number;
  createdAt: string;
  studentCount: number;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 px-5 py-4">
      <div>
        <p className="font-medium text-slate-900 dark:text-white">{title}</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {sceneCount} <I18nText k="instructorDashboard.scenes" fallback="scenes" /> &middot; {studentCount} <I18nText k="instructorDashboard.students" fallback="students" /> &middot; <I18nText k="instructorDashboard.created" fallback="created" />{' '}
          {new Date(createdAt).toLocaleDateString()}
        </p>
      </div>
      <Link
        href={`/instructor/classrooms/${id}/overview`}
        className="rounded-lg border border-slate-200 dark:border-white/10 px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white transition-colors"
      >
        <I18nText k="instructorDashboard.manage" fallback="Manage" />
      </Link>
    </div>
  );
}
