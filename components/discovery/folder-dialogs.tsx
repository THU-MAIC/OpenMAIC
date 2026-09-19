'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  displayNameWidth,
  FOLDER_NAME_MAX_WIDTH,
  FOLDER_COUNT_LIMIT,
  validateFolderName,
} from '@/lib/utils/folder-name-validation';
import type { FolderRecord } from '@/lib/utils/database';
import { FolderNameError } from '@/lib/utils/stage-storage';

// ============ F1: New folder dialog ============

export function NewFolderDialog({
  open,
  onOpenChange,
  folders,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  folders: FolderRecord[];
  onCreate: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const width = displayNameWidth(name.trim());

  const submit = async () => {
    if (submitting) return;
    const widthCheck = validateFolderName(name);
    if (!widthCheck.ok) {
      setError(
        widthCheck.kind === 'empty'
          ? t('classroom.folderNameEmpty')
          : t('classroom.folderWidth', { width: widthCheck.width, max: FOLDER_NAME_MAX_WIDTH }),
      );
      return;
    }
    const trimmed = name.trim();
    // Case-insensitive duplicate check, matching the storage-boundary rule.
    if (folders.some((f) => f.name.toLowerCase() === trimmed.toLowerCase())) {
      setError(t('classroom.folderNameExists'));
      return;
    }
    if (folders.length >= FOLDER_COUNT_LIMIT) {
      setError(t('classroom.folderCountLimit'));
      return;
    }
    setSubmitting(true);
    try {
      await onCreate(trimmed);
      onOpenChange(false);
    } catch (err) {
      // Map the storage-boundary error to a specific message when possible.
      if (err instanceof FolderNameError) {
        setError(
          err.kind === 'duplicate'
            ? t('classroom.folderNameExists')
            : err.kind === 'tooLong'
              ? t('classroom.folderWidth', {
                  width: displayNameWidth(trimmed),
                  max: FOLDER_NAME_MAX_WIDTH,
                })
              : err.kind === 'limit'
                ? t('classroom.folderCountLimit')
                : t('classroom.folderNameHint'),
        );
      } else {
        setError(t('classroom.folderCreateFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('classroom.newFolderTitle')}</DialogTitle>
          <DialogDescription>{t('classroom.newFolderDesc')}</DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <label className="text-[13px] text-muted-foreground">
            {t('classroom.folderNameLabel')}
          </label>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={t('classroom.folderNamePlaceholder')}
            maxLength={80}
            className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px] outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400"
          />
          <div className="mt-1.5 flex items-center justify-between text-[11px]">
            <span className={error ? 'text-destructive' : 'text-muted-foreground/70'}>
              {error ?? t('classroom.folderNameHint')}
            </span>
            <span
              className={
                width > FOLDER_NAME_MAX_WIDTH ? 'text-destructive' : 'text-muted-foreground/60'
              }
            >
              {t('classroom.folderWidth', {
                width: Math.max(0, width),
                max: FOLDER_NAME_MAX_WIDTH,
              })}
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!name.trim() || submitting}>
            {t('classroom.folderCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
