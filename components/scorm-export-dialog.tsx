'use client';

import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ScormExportOptions } from '@/lib/export/scorm';

interface ScormExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (options: ScormExportOptions) => void;
}

export function ScormExportDialog({ open, onOpenChange, onConfirm }: ScormExportDialogProps) {
  const { t } = useI18n();
  const [includeVideos, setIncludeVideos] = useState(false);

  function handleConfirm() {
    onOpenChange(false);
    onConfirm({ includeVideos });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <BookOpen className="w-5 h-5 text-purple-500" />
            <DialogTitle>{t('export.scormDialogTitle')}</DialogTitle>
          </div>
          <DialogDescription>{t('export.scormDialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label
            className={`flex items-start gap-3 p-3.5 rounded-lg border-2 cursor-pointer transition-colors ${
              !includeVideos
                ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <input
              type="radio"
              name="video-option"
              className="mt-0.5 accent-purple-500"
              checked={!includeVideos}
              onChange={() => setIncludeVideos(false)}
            />
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                {t('export.scormReplacePoster')}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                ✓ Recommended
              </div>
            </div>
          </label>

          <label
            className={`flex items-start gap-3 p-3.5 rounded-lg border-2 cursor-pointer transition-colors ${
              includeVideos
                ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <input
              type="radio"
              name="video-option"
              className="mt-0.5 accent-purple-500"
              checked={includeVideos}
              onChange={() => setIncludeVideos(true)}
            />
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                {t('export.scormIncludeVideos')}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                ⚠ May exceed LMS upload limits (100–300 MB)
              </div>
            </div>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleConfirm} className="bg-purple-600 hover:bg-purple-700 text-white">
            {t('export.scormExport')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
