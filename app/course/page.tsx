'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCourseStore } from '@/lib/store/course';
import type { CourseListItem } from '@/lib/types/course';
import { CourseForm } from '@/components/course/course-form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { ArrowLeft, Plus, BookOpen, Trash2, GraduationCap, User } from 'lucide-react';
import { cn } from '@/lib/utils';

const COVERS = [
  { from: '#7c3aed', to: '#a78bfa' },
  { from: '#0ea5e9', to: '#38bdf8' },
  { from: '#059669', to: '#34d399' },
  { from: '#e11d48', to: '#fb7185' },
  { from: '#d97706', to: '#fbbf24' },
  { from: '#0d9488', to: '#2dd4bf' },
  { from: '#c026d3', to: '#e879f9' },
  { from: '#ea580c', to: '#fb923c' },
];

function coverFor(id: string) {
  const hash = id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return COVERS[hash % COVERS.length];
}

interface CourseCardProps {
  course: CourseListItem;
  index: number;
  onOpen: () => void;
  onDelete: () => void;
  chapterLabel: string;
}

function CourseCard({ course, index, onOpen, onDelete, chapterLabel }: CourseCardProps) {
  const cover = coverFor(course.id);

  return (
    <motion.div
      initial={{ opacity: 0, y: 22 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.055, duration: 0.38, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === 'Enter' && onOpen()}
        className={cn(
          'group rounded-2xl overflow-hidden cursor-pointer flex flex-col',
          'border border-white/10 shadow-md hover:shadow-2xl',
          'hover:-translate-y-1.5 transition-all duration-300',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
        )}
        style={{ minHeight: '220px' }}
      >
        {/* Cover area — compact, holds course name */}
        <div
          className="relative flex-shrink-0 h-[88px] overflow-hidden flex flex-col justify-between px-4 pt-3 pb-3"
          style={{ background: `linear-gradient(135deg, ${cover.from}, ${cover.to})` }}
        >
          {/* Geometric decorations */}
          <div
            className="absolute -top-5 -right-5 w-24 h-24 rounded-full opacity-20"
            style={{ background: 'rgba(255,255,255,0.4)' }}
          />
          <div
            className="absolute -bottom-6 -left-3 w-28 h-28 rounded-full opacity-10"
            style={{ background: 'rgba(255,255,255,0.6)' }}
          />
          {/* Top row: chapter badge + delete */}
          <div className="relative z-10 flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-white/20 backdrop-blur-sm text-white px-2 py-0.5 rounded-full border border-white/30">
              <BookOpen className="size-2.5" />
              {course.chapterCount} {chapterLabel}
            </span>
            <button
              className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-white/15 hover:bg-white/30 backdrop-blur-sm text-white p-1 rounded-lg"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              aria-label="删除课程"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
          {/* Course name on gradient */}
          <h2 className="relative z-10 text-[13px] font-bold text-white leading-snug line-clamp-1 tracking-tight drop-shadow-sm">
            {course.name}
          </h2>
        </div>

        {/* Info area — taller now, 3 lines of description */}
        <div className="flex-1 flex flex-col bg-white dark:bg-slate-900 px-4 pt-3 pb-4 min-h-0">
          {course.description ? (
            <p className="text-[11px] text-muted-foreground line-clamp-3 mb-auto leading-relaxed">
              {course.description}
            </p>
          ) : (
            <div className="mb-auto" />
          )}
          <div className="mt-2.5 pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <GraduationCap className="size-3 flex-shrink-0" style={{ color: cover.from }} />
              <span className="text-[11px] text-muted-foreground truncate">
                {course.college} · {course.major}
              </span>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <User className="size-2.5 text-muted-foreground/60" />
              <span className="text-[11px] text-muted-foreground/70 truncate max-w-[72px]">{course.teacherName}</span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default function CoursePage() {
  const { t } = useI18n();
  const router = useRouter();
  const { courses, fetchCourses, createCourse, deleteCourse } = useCourseStore();
  const [showForm, setShowForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  const handleCreate = async (data: Parameters<typeof createCourse>[0]) => {
    await createCourse(data);
    setShowForm(false);
  };

  const handleConfirmDelete = async () => {
    if (!deletingId) return;
    await deleteCourse(deletingId);
    setDeletingId(null);
  };

  return (
    <div className="relative min-h-[100dvh] bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      {/* Decorative blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-500/8 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/3 w-96 h-96 bg-violet-500/8 rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-5xl mx-auto">
        {/* Page header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="flex justify-between items-center mb-8"
        >
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => router.push('/')}>
              <ArrowLeft />
              {t('course.backToHome')}
            </Button>
            <h1 className="text-2xl font-bold text-foreground">{t('course.myCourses')}</h1>
          </div>
          <Button onClick={() => setShowForm(true)}>
            <Plus />
            {t('course.create')}
          </Button>
        </motion.div>

        {/* Empty state */}
        {courses.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.4 }}
            className="text-center py-20"
          >
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-muted mb-5">
              <BookOpen className="size-9 text-muted-foreground" />
            </div>
            <p className="text-lg font-medium text-foreground mb-2">{t('course.emptyStateTitle')}</p>
            <p className="text-muted-foreground text-sm mb-6">{t('course.emptyStateDesc')}</p>
            <Button onClick={() => setShowForm(true)}>
              <Plus />
              {t('course.create')}
            </Button>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {courses.map((course, i) => (
              <CourseCard
                key={course.id}
                course={course}
                index={i}
                onOpen={() => router.push(`/course/${course.id}`)}
                onDelete={() => setDeletingId(course.id)}
                chapterLabel={t('course.chapter')}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create course dialog */}
      <Dialog open={showForm} onOpenChange={(open) => { if (!open) setShowForm(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('course.create')}</DialogTitle>
          </DialogHeader>
          <CourseForm onSubmit={handleCreate} onCancel={() => setShowForm(false)} />
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('course.confirmDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('course.confirmDelete')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('course.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDelete}>
              {t('course.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
