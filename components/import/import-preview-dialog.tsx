'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  FileArchive,
  FileQuestion,
  Globe2,
  HardDrive,
  Images,
  Layers3,
  LoaderCircle,
  RadioTower,
  Users,
  WifiOff,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ClassroomPackageError,
  importClassroomPackage,
  type ClassroomPackageProgress,
  type ClassroomPackageScan,
  type ImportedClassroomPackage,
  type OfflineLevel,
} from '@/lib/import/classroom-package';
import { ImportProgress } from './import-progress';

export interface ImportPreviewDialogProps {
  scan: ClassroomPackageScan | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (result: ImportedClassroomPackage) => void;
  onError?: (error: ClassroomPackageError) => void;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const sceneLabels: Record<string, string> = {
  slide: '课件',
  quiz: '测验',
  interactive: '互动',
  pbl: '项目式学习',
};

function offlinePresentation(level: OfflineLevel) {
  if (level === 'complete') {
    return {
      label: '完全离线',
      description: '课程所需资源均已打包，可在无网络环境中播放。',
      Icon: WifiOff,
      className:
        'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-300',
    };
  }
  if (level === 'partial') {
    return {
      label: '基础离线',
      description: '主体课程可保存在本机，但部分资源可能缺失或依赖网络。',
      Icon: CloudOff,
      className:
        'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300',
    };
  }
  return {
    label: '需要网络',
    description: '关键播放内容含外部链接，离线时可能无法完整呈现。',
    Icon: RadioTower,
    className:
      'border-orange-200 bg-orange-50 text-orange-900 dark:border-orange-900 dark:bg-orange-950/35 dark:text-orange-300',
  };
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Layers3;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border bg-muted/25 p-3">
      <Icon className="text-muted-foreground mb-2 size-4" aria-hidden="true" />
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

export function ImportPreviewDialog({
  scan,
  open,
  onOpenChange,
  onImported,
  onError,
}: ImportPreviewDialogProps) {
  const [progress, setProgress] = useState<ClassroomPackageProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setProgress(null);
      setImporting(false);
      setError(null);
    }
  }, [open]);

  const offline = useMemo(
    () => (scan ? offlinePresentation(scan.preview.offlineLevel) : null),
    [scan],
  );
  if (!scan || !offline) return null;

  const { preview } = scan;
  const blockingIssues = preview.issues.filter((issue) => issue.severity === 'error');
  const warningIssues = preview.issues.filter((issue) => issue.severity === 'warning');

  const commit = async () => {
    if (importing || !preview.canImport) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importClassroomPackage(scan, { onProgress: setProgress });
      onImported?.(result);
      onOpenChange(false);
    } catch (caught) {
      const packageError =
        caught instanceof ClassroomPackageError
          ? caught
          : new ClassroomPackageError('import-failed', '课程导入失败。', caught);
      setError(packageError.message);
      onError?.(packageError);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !importing && onOpenChange(nextOpen)}>
      <DialogContent
        className="max-h-[90vh] max-w-3xl gap-0 overflow-hidden p-0"
        showCloseButton={!importing}
      >
        <DialogHeader className="border-b px-6 py-5 pr-14">
          <div className="flex items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <FileArchive className="size-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg">导入“{preview.title}”</DialogTitle>
              <DialogDescription className="mt-1 truncate">
                {preview.packageName} · 格式 v{preview.formatVersion}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-150px)]">
          <div className="space-y-5 p-6">
            {progress && <ImportProgress {...progress} />}
            {error && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>导入没有完成</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className={`rounded-xl border p-4 ${offline.className}`}>
              <div className="flex gap-3">
                <offline.Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <div>
                  <div className="font-semibold">{offline.label}</div>
                  <div className="mt-0.5 text-sm opacity-80">{offline.description}</div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric icon={Layers3} label="课程场景" value={String(preview.sceneCount)} />
              <Metric icon={Users} label="课堂角色" value={String(preview.agentCount)} />
              <Metric icon={Images} label="媒体资源" value={String(preview.mediaCount)} />
              <Metric
                icon={HardDrive}
                label="本地占用预计"
                value={formatBytes(preview.uncompressedBytes)}
              />
            </div>

            <section>
              <h3 className="mb-2 text-sm font-semibold">课程内容</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(preview.sceneTypes).map(([type, count]) => (
                  <Badge variant="secondary" key={type}>
                    {sceneLabels[type] || type} {count}
                  </Badge>
                ))}
                <Badge variant="outline">音频 {preview.mediaTypes.audio}</Badge>
                <Badge variant="outline">
                  图片/视频 {preview.mediaTypes.image + preview.mediaTypes.video}
                </Badge>
              </div>
            </section>

            {(blockingIssues.length > 0 || warningIssues.length > 0) && (
              <section>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <AlertTriangle className="size-4 text-amber-600" />
                  导入检查
                </h3>
                <div className="space-y-2">
                  {[...blockingIssues, ...warningIssues].map((issue, index) => (
                    <div
                      key={`${issue.code}-${issue.path || index}`}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        issue.severity === 'error'
                          ? 'border-destructive/30 bg-destructive/5 text-destructive'
                          : 'border-amber-200 bg-amber-50/70 text-amber-900 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-300'
                      }`}
                    >
                      {issue.message}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(preview.missingResources.length > 0 || preview.externalResources.length > 0) && (
              <section className="grid gap-3 sm:grid-cols-2">
                {preview.missingResources.length > 0 && (
                  <div className="rounded-xl border p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                      <FileQuestion className="size-4 text-amber-600" />
                      缺失资源 {preview.missingResources.length}
                    </div>
                    <div className="text-muted-foreground max-h-28 space-y-1 overflow-auto text-xs">
                      {preview.missingResources.slice(0, 12).map((resource) => (
                        <div className="truncate" title={resource.path} key={resource.path}>
                          {resource.path}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {preview.externalResources.length > 0 && (
                  <div className="rounded-xl border p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                      <Globe2 className="size-4 text-orange-600" />
                      外部链接 {preview.externalResources.length}
                    </div>
                    <div className="text-muted-foreground max-h-28 space-y-1 overflow-auto text-xs">
                      {preview.externalResources.slice(0, 12).map((resource) => (
                        <div
                          className="truncate"
                          title={resource.url}
                          key={`${resource.url}-${resource.referencedBy}`}
                        >
                          {resource.url}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {preview.canImport && warningIssues.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="size-4" />
                课程结构与资源检查通过
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="border-t bg-muted/20 px-6 py-4 sm:items-center">
          <span className="text-muted-foreground mr-auto text-xs">
            导入过程仅写入浏览器本地课程库
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
            取消
          </Button>
          <Button onClick={() => void commit()} disabled={!preview.canImport || importing}>
            {importing ? <LoaderCircle className="animate-spin" /> : <HardDrive />}
            {importing ? '正在导入' : '保存到我的课程'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
