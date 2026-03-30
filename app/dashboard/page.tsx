'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { ArrowLeft, BookOpen, Plus, GraduationCap } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { ClassroomIndexEntry } from '@/lib/server/classroom-index';

const LANGUAGE_BADGES: Record<string, { label: string; color: string }> = {
  'zh-CN': { label: '中文', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  'en-US': { label: 'EN', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  uz: { label: 'UZ', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
};

function formatRelativeDate(iso: string, t: (key: string) => string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return t('classroom.today');
  if (diffDays === 1) return t('classroom.yesterday');
  if (diffDays < 7) return `${diffDays} ${t('classroom.daysAgo')}`;
  return date.toLocaleDateString();
}

export default function DashboardPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [classrooms, setClassrooms] = useState<ClassroomIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/classrooms')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setClassrooms(data.classrooms);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-4 md:p-8">
      {/* Header */}
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="p-2 rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-200">
                {t('classroom.myClassrooms')}
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {classrooms.length > 0
                  ? `${classrooms.length} ${t('classroom.scenes')}`
                  : ''}
              </p>
            </div>
          </div>
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            {t('classroom.createFirst')}
          </button>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-40 rounded-xl bg-white/60 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700 animate-pulse"
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && classrooms.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-32 text-center"
          >
            <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
              <GraduationCap className="w-8 h-8 text-gray-400 dark:text-gray-500" />
            </div>
            <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">
              {t('classroom.noClassrooms')}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              {t('classroom.noClassroomsDesc')}
            </p>
            <button
              onClick={() => router.push('/')}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              {t('classroom.createFirst')}
            </button>
          </motion.div>
        )}

        {/* Classroom grid */}
        {!loading && classrooms.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {classrooms.map((classroom, i) => {
              const badge = LANGUAGE_BADGES[classroom.language] || LANGUAGE_BADGES['en-US'];
              return (
                <motion.div
                  key={classroom.id}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.3 }}
                  className="group relative rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 transition-all cursor-pointer overflow-hidden"
                  onClick={() => router.push(`/classroom/${classroom.id}`)}
                >
                  <div className="p-5">
                    {/* Top row: badge + date */}
                    <div className="flex items-center justify-between mb-3">
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide',
                          badge.color,
                        )}
                      >
                        {badge.label}
                      </span>
                      <span className="text-[11px] text-gray-400 dark:text-gray-500">
                        {formatRelativeDate(classroom.createdAt, t)}
                      </span>
                    </div>

                    {/* Title */}
                    <h3 className="text-[15px] font-semibold text-gray-800 dark:text-gray-200 leading-snug line-clamp-2 mb-3 group-hover:text-primary transition-colors">
                      {classroom.title}
                    </h3>

                    {/* Bottom row: scene count + open button */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>
                          {classroom.sceneCount} {t('classroom.scenes')}
                        </span>
                      </div>
                      <span className="text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        {t('classroom.open')} →
                      </span>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
