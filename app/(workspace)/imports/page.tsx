'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  FileArchive,
  FolderOpen,
  History,
  LoaderCircle,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WorkspacePageHeader } from '@/components/workspace/page-header';
import { useWorkspaceImport } from '@/components/workspace/workspace-import-controller';
import { listImportJobs, type ImportJobRecord } from '@/lib/workspace';

const statusCopy: Record<ImportJobRecord['status'], { label: string; className: string }> = {
  queued: {
    label: '等待中',
    className: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
  parsing: {
    label: '正在解析',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  },
  validating: {
    label: '正在检查',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  },
  writing_media: {
    label: '写入媒体',
    className: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  },
  writing_course: {
    label: '写入课程',
    className: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  },
  completed: {
    label: '导入成功',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  },
  failed: {
    label: '导入失败',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  cancelled: {
    label: '已取消',
    className: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
};

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatBytes(bytes?: number) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export default function ImportsPage() {
  const { openImporter } = useWorkspaceImport();
  const [jobs, setJobs] = useState<ImportJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setJobs(await listImportJobs({ limit: 100 }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取本机导入记录');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const changed = () => void refresh();
    window.addEventListener('openmaic:workspace-changed', changed);
    return () => window.removeEventListener('openmaic:workspace-changed', changed);
  }, [refresh]);

  return (
    <div>
      <WorkspacePageHeader
        eyebrow="Import center"
        title="导入中心"
        description="查看资源包扫描与导入历史。失败记录会保留原因，但不会留下半写入的课程。"
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void refresh()}
              className="h-10 rounded-xl bg-white/70 dark:bg-white/5"
            >
              <RotateCcw /> 刷新
            </Button>
            <Button
              onClick={openImporter}
              className="h-10 rounded-xl bg-violet-600 px-4 hover:bg-violet-700"
            >
              <Upload /> 新建导入
            </Button>
          </>
        }
      />

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          {
            label: '全部记录',
            value: jobs.length,
            icon: History,
            color: 'text-violet-600 bg-violet-100 dark:bg-violet-950 dark:text-violet-300',
          },
          {
            label: '成功导入',
            value: jobs.filter((job) => job.status === 'completed').length,
            icon: CheckCircle2,
            color: 'text-emerald-600 bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300',
          },
          {
            label: '需要处理',
            value: jobs.filter((job) => job.status === 'failed').length,
            icon: AlertCircle,
            color: 'text-red-600 bg-red-100 dark:bg-red-950 dark:text-red-300',
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className="flex items-center gap-3 rounded-2xl border border-white bg-white/75 p-4 dark:border-white/10 dark:bg-white/[0.04]"
            >
              <span className={`grid size-10 place-items-center rounded-xl ${item.color}`}>
                <Icon className="size-4" />
              </span>
              <div>
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <p className="mt-0.5 text-xl font-semibold">{loading ? '—' : item.value}</p>
              </div>
            </div>
          );
        })}
      </section>

      <section className="mt-6 overflow-hidden rounded-[24px] border border-white bg-white/80 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
        {loading ? (
          <div className="grid min-h-64 place-items-center">
            <LoaderCircle className="size-6 animate-spin text-violet-600" />
          </div>
        ) : error ? (
          <div className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
            <AlertCircle className="size-9 text-red-500" />
            <h2 className="mt-4 font-semibold">无法读取导入记录</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{error}</p>
            <Button onClick={() => void refresh()} variant="outline" className="mt-5 rounded-xl">
              <RotateCcw /> 重试
            </Button>
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center p-8 text-center">
            <FileArchive className="size-10 text-violet-500" />
            <h2 className="mt-4 font-semibold">还没有导入记录</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              拖入一个 .maic.zip 或课程文件夹，系统会先检查格式、安全限制和离线资源完整度。
            </p>
            <Button
              onClick={openImporter}
              className="mt-5 rounded-xl bg-violet-600 hover:bg-violet-700"
            >
              <Upload /> 导入第一门课程
            </Button>
          </div>
        ) : (
          <div className="divide-y dark:divide-white/10">
            {jobs.map((job) => {
              const SourceIcon = job.sourceType === 'folder' ? FolderOpen : FileArchive;
              const status = statusCopy[job.status];
              const running = [
                'queued',
                'parsing',
                'validating',
                'writing_media',
                'writing_course',
              ].includes(job.status);
              return (
                <article
                  key={job.id}
                  className="grid gap-4 p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:p-5"
                >
                  <span className="grid size-11 place-items-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                    <SourceIcon className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold">
                        {job.detectedTitle || job.sourceName}
                      </h3>
                      <Badge className={status.className}>
                        {running && <LoaderCircle className="animate-spin" />} {status.label}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>{job.sourceName}</span>
                      <span>{formatBytes(job.sourceSize)}</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="size-3" /> {formatDate(job.createdAt)}
                      </span>
                    </div>
                    {job.error && (
                      <p className="mt-2 text-xs text-red-600 dark:text-red-300">
                        {job.error.message}
                      </p>
                    )}
                    {job.warnings.length > 0 && (
                      <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        {job.warnings.length} 项提示：{job.warnings[0].message}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 sm:justify-end">
                    {job.stageId && job.status === 'completed' ? (
                      <Button asChild variant="outline" className="h-9 rounded-xl bg-transparent">
                        <Link href={`/courses/${job.stageId}`}>查看课程</Link>
                      </Button>
                    ) : null}
                    {job.status === 'failed' ? (
                      <Button
                        onClick={openImporter}
                        variant="outline"
                        className="h-9 rounded-xl bg-transparent"
                      >
                        重新导入
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
