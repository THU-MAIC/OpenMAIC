'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type {
  ClassroomPackageError,
  ClassroomPackageScan,
  ImportedClassroomPackage,
} from '@/lib/import/classroom-package';
import { cn } from '@/lib/utils';
import { ClassroomPackageDropzone } from './classroom-package-dropzone';
import { ImportPreviewDialog } from './import-preview-dialog';

export interface ClassroomPackageImporterProps {
  onImported?: (result: ImportedClassroomPackage) => void;
  onError?: (error: ClassroomPackageError) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

/** Dropzone + preview dialog convenience wrapper for pages that do not need custom state. */
export function ClassroomPackageImporter({
  onImported,
  onError,
  disabled,
  compact,
  className,
}: ClassroomPackageImporterProps) {
  const [scan, setScan] = useState<ClassroomPackageScan | null>(null);
  const [open, setOpen] = useState(false);

  const handleError = (error: ClassroomPackageError) => {
    toast.error(error.message);
    onError?.(error);
  };

  return (
    <div className={cn(className)}>
      <ClassroomPackageDropzone
        disabled={disabled}
        compact={compact}
        onError={handleError}
        onScanComplete={(nextScan) => {
          setScan(nextScan);
          setOpen(true);
        }}
      />
      <ImportPreviewDialog
        scan={scan}
        open={open}
        onOpenChange={setOpen}
        onError={handleError}
        onImported={(result) => {
          toast.success(`“${result.title}”已保存到我的课程`);
          onImported?.(result);
        }}
      />
    </div>
  );
}
