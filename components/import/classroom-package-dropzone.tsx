'use client';

import { useCallback, useRef, useState } from 'react';
import { FileArchive, FolderOpen, LoaderCircle, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ClassroomPackageError,
  collectDroppedPackage,
  scanClassroomPackage,
  type ClassroomPackageInput,
  type ClassroomPackageProgress,
  type ClassroomPackageScan,
} from '@/lib/import/classroom-package';
import { ImportProgress } from './import-progress';

export interface ClassroomPackageDropzoneProps {
  onScanComplete: (scan: ClassroomPackageScan) => void;
  onError?: (error: ClassroomPackageError) => void;
  onProgress?: (progress: ClassroomPackageProgress) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

function asPackageError(error: unknown): ClassroomPackageError {
  return error instanceof ClassroomPackageError
    ? error
    : new ClassroomPackageError('invalid-input', '无法读取拖入的课程包。', error);
}

export function ClassroomPackageDropzone({
  onScanComplete,
  onError,
  onProgress,
  disabled = false,
  compact = false,
  className,
}: ClassroomPackageDropzoneProps) {
  const zipInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ClassroomPackageProgress | null>(null);

  const emitProgress = useCallback(
    (update: ClassroomPackageProgress) => {
      setProgress(update);
      onProgress?.(update);
    },
    [onProgress],
  );

  const scan = useCallback(
    async (input: ClassroomPackageInput) => {
      if (disabled || busy) return;
      setBusy(true);
      try {
        const result = await scanClassroomPackage(input, { onProgress: emitProgress });
        onScanComplete(result);
      } catch (error) {
        onError?.(asPackageError(error));
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [busy, disabled, emitProgress, onError, onScanComplete],
  );

  const onDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      // This dropzone is often rendered inside WorkspaceImportController,
      // which also accepts page-level drops. Keep one browser drop mapped to
      // exactly one scan instead of allowing the event to bubble and scan the
      // same (potentially large) package twice.
      event.stopPropagation();
      setDragging(false);
      if (disabled || busy) return;
      try {
        await scan(await collectDroppedPackage(event.dataTransfer));
      } catch (error) {
        onError?.(asPackageError(error));
      }
    },
    [busy, disabled, onError, scan],
  );

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border border-dashed bg-card text-center transition-all duration-200',
        compact ? 'p-5' : 'px-6 py-10 sm:px-10',
        dragging &&
          'border-primary bg-primary/5 shadow-[0_0_0_4px_color-mix(in_oklab,var(--primary)_10%,transparent)]',
        !dragging && 'border-border hover:border-primary/50 hover:bg-muted/25',
        (disabled || busy) && 'pointer-events-none opacity-65',
        className,
      )}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled && !busy) setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      aria-busy={busy}
    >
      <input
        ref={zipInputRef}
        type="file"
        accept=".maic.zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void scan(file);
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        multiple
        {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) void scan({ kind: 'folder', files });
        }}
      />

      {progress ? (
        <ImportProgress {...progress} className="mx-auto max-w-xl text-left" />
      ) : (
        <>
          <div
            className={cn(
              'mx-auto mb-4 grid place-items-center rounded-2xl bg-primary/10 text-primary transition-transform group-hover:-translate-y-0.5',
              compact ? 'size-11' : 'size-14',
            )}
          >
            {busy ? (
              <LoaderCircle className="size-6 animate-spin" />
            ) : (
              <UploadCloud className={compact ? 'size-5' : 'size-7'} />
            )}
          </div>
          <p className={cn('font-semibold', compact ? 'text-sm' : 'text-lg')}>
            {dragging ? '松开即可检查课程包' : '把课程包或课程文件夹拖到这里'}
          </p>
          <p className="text-muted-foreground mt-1.5 text-sm">在本机解析并预检，不会上传课程内容</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              size={compact ? 'sm' : 'default'}
              onClick={() => zipInputRef.current?.click()}
              disabled={disabled || busy}
            >
              <FileArchive data-icon="inline-start" />
              选择 .maic.zip
            </Button>
            <Button
              type="button"
              variant="outline"
              size={compact ? 'sm' : 'default'}
              onClick={() => folderInputRef.current?.click()}
              disabled={disabled || busy}
            >
              <FolderOpen data-icon="inline-start" />
              选择文件夹
            </Button>
          </div>
          {!compact && (
            <p className="text-muted-foreground/80 mt-4 text-xs">
              导入前会检查格式、文件完整性、外部链接与离线可用性
            </p>
          )}
        </>
      )}
    </div>
  );
}
