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
      setError(t('classroom.folderWidth', { width: widthCheck.width, max: FOLDER_NAME_MAX_WIDTH }));
      return;
    }
    const trimmed = name.trim();
    if (folders.some((f) => f.name === trimmed)) {
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
    } catch {
      setError(t('classroom.folderCreateFailed'));
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

// ============ F3: Delete folder dialog ============

export type DeleteFolderMode = 'ungroup' | 'remove';

export function DeleteFolderDialog({
  open,
  onOpenChange,
  folder,
  courseCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  folder: FolderRecord | null;
  courseCount: number;
  onConfirm: (mode: DeleteFolderMode) => Promise<void>;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<DeleteFolderMode>('ungroup');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setMode('ungroup');
      setSubmitting(false);
    }
  }, [open]);

  if (!folder) return null;

  const isEmpty = courseCount === 0;

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(isEmpty ? 'ungroup' : mode);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('classroom.deleteFolderTitle', { name: folder.name })}</DialogTitle>
          <DialogDescription>
            {isEmpty
              ? t('classroom.deleteFolderEmptyDesc')
              : t('classroom.deleteFolderDesc', { count: courseCount })}
          </DialogDescription>
        </DialogHeader>

        {!isEmpty && (
          <div className="py-2 space-y-2">
            <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
              <input
                type="radio"
                name="delete-mode"
                checked={mode === 'ungroup'}
                onChange={() => setMode('ungroup')}
                className="mt-0.5 accent-violet-500"
              />
              <div className="flex-1">
                <div className="text-[14px] font-medium text-foreground">
                  {t('classroom.deleteFolderUngroupTitle')}
                </div>
                <div className="text-[12px] text-muted-foreground mt-0.5">
                  {t('classroom.deleteFolderUngroupDesc')}
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
              <input
                type="radio"
                name="delete-mode"
                checked={mode === 'remove'}
                onChange={() => setMode('remove')}
                className="mt-0.5 accent-red-500"
              />
              <div className="flex-1">
                <div className="text-[14px] font-medium text-foreground">
                  {t('classroom.deleteFolderRemoveTitle')}
                </div>
                <div className="text-[12px] text-muted-foreground mt-0.5">
                  {t('classroom.deleteFolderRemoveDesc')}
                </div>
              </div>
            </label>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={mode === 'remove' && !isEmpty ? 'destructive' : 'default'}
            onClick={confirm}
            disabled={submitting}
          >
            {mode === 'remove' && !isEmpty
              ? t('classroom.deleteFolderRemoveAction')
              : t('classroom.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
