'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/admin/common/EmptyState';
import { useI18n } from '@/lib/hooks/use-i18n';

interface ClassroomRow {
  classroomId: string;
  title: string;
  ownerUserId: string;
  studentCount: number;
  updatedAt: string;
  status: 'active' | 'missing';
  recoverable: boolean;
}

export default function AdminClassroomsPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<ClassroomRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/admin/classrooms');
    const data = await res.json();
    setRows(data.classrooms ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const handleRecover = useCallback(
    async (classroomId: string) => {
      setRecoveringId(classroomId);
      try {
        const res = await fetch('/api/admin/classrooms/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: classroomId }),
        });

        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(payload.error || t('adminClassrooms.recoverFailed'));
          return;
        }

        toast.success(t('adminClassrooms.recoverSuccess'));
      } finally {
        setRecoveringId(null);
        await fetchRows();
      }
    },
    [fetchRows],
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('adminClassrooms.title')}</h1>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5">
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title={t('adminClassrooms.noClassrooms')} description={t('adminClassrooms.noClassroomsDesc')} />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-white/10">
                {[t('adminClassrooms.columns.classroom'), t('adminClassrooms.columns.title'), t('adminClassrooms.columns.owner'), t('adminClassrooms.columns.students'), t('adminClassrooms.columns.updated'), ''].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {rows.map((row) => (
                <tr key={row.classroomId} className="hover:bg-slate-50 dark:hover:bg-white/5">
                  <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-200">{row.classroomId}</td>
                  <td className={`px-4 py-3 ${row.status === 'missing' ? 'text-amber-600 dark:text-amber-300' : 'text-slate-900 dark:text-white'}`}>
                    {row.title}
                  </td>
                  <td className={`px-4 py-3 ${row.status === 'missing' ? 'text-amber-500 dark:text-amber-200/90' : 'text-slate-600 dark:text-slate-300'}`}>
                    {row.ownerUserId}
                  </td>
                  <td className={`px-4 py-3 ${row.status === 'missing' ? 'text-amber-500 dark:text-amber-200/90' : 'text-slate-600 dark:text-slate-300'}`}>
                    {row.studentCount}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{new Date(row.updatedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    {row.status === 'active' ? (
                      <Link href={`/admin/classrooms/${row.classroomId}`} className="text-primary hover:text-primary/80">
                        {t('adminClassrooms.manage')}
                      </Link>
                    ) : row.recoverable ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-200 hover:bg-amber-500/10"
                        onClick={() => void handleRecover(row.classroomId)}
                        disabled={recoveringId === row.classroomId}
                      >
                        {recoveringId === row.classroomId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        {t('adminClassrooms.recover')}
                      </Button>
                    ) : (
                      <span className="text-xs text-amber-600 dark:text-amber-300/80">{t('adminClassrooms.missing')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
