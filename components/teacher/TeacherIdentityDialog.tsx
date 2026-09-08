'use client';

import { useEffect, useState } from 'react';
import { Copy, Download, KeyRound, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TeacherCopy } from '@/lib/i18n/teacher';
import { teacherRequest } from './student-ui';

export function TeacherIdentityDialog({
  copy,
  onClose,
}: {
  copy: TeacherCopy;
  onClose: () => void;
}) {
  const [recoveryCode, setRecoveryCode] = useState('');
  const [restoreCode, setRestoreCode] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    teacherRequest<{ recoveryCode: string }>('/api/teacher/identity', { signal: controller.signal })
      .then((response) => setRecoveryCode(response.recoveryCode))
      .catch(() => {
        if (!controller.signal.aborted) setError(copy.failed);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [copy.failed, retry]);

  async function copyCode() {
    setError('');
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setNotice(copy.copied);
    } catch {
      setError(copy.copyFailed);
    }
  }

  function downloadCode() {
    const url = URL.createObjectURL(
      new Blob([recoveryCode + '\n'], { type: 'text/plain;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'openmaic-teacher-recovery.txt';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(copy.downloaded);
  }

  async function restore() {
    const value = restoreCode.trim();
    if (
      !/^openmaic-teacher-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      setError(copy.invalidRecovery);
      return;
    }
    setRestoring(true);
    setError('');
    setNotice('');
    try {
      await teacherRequest<{ restored: true }>('/api/teacher/identity', {
        method: 'POST',
        body: JSON.stringify({ recoveryCode: value }),
      });
      window.location.reload();
    } catch {
      setError(copy.restoreFailed);
      setRestoring(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !restoring && onClose()}>
      <DialogContent
        className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg"
        showCloseButton={!restoring}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{copy.identityTitle}</DialogTitle>
          <DialogDescription>{copy.identityDescription}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <p role="status" className="text-muted-foreground flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin" />
            {copy.identityLoading}
          </p>
        ) : recoveryCode ? (
          <div className="min-w-0 space-y-3">
            <Label htmlFor="teacher-recovery-code">{copy.recoveryCode}</Label>
            <Input
              id="teacher-recovery-code"
              type="password"
              autoComplete="off"
              readOnly
              value={recoveryCode}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={copyCode} disabled={restoring}>
                <Copy />
                {copy.copy}
              </Button>
              <Button variant="outline" onClick={downloadCode} disabled={restoring}>
                <Download />
                {copy.download}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              setLoading(true);
              setError('');
              setRetry((value) => value + 1);
            }}
          >
            <RefreshCw />
            {copy.retry}
          </Button>
        )}
        <div className="min-w-0 space-y-4 border-t pt-5">
          {!showRestore ? (
            <Button
              variant="outline"
              onClick={() => {
                setShowRestore(true);
                setError('');
                setNotice('');
              }}
            >
              <KeyRound />
              {copy.restoreWorkspace}
            </Button>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">{copy.restoreDescription}</p>
              <Label htmlFor="teacher-restore-code">{copy.recoveryCode}</Label>
              <Input
                id="teacher-restore-code"
                type="password"
                autoComplete="off"
                placeholder={copy.recoveryPlaceholder}
                value={restoreCode}
                disabled={restoring}
                onChange={(event) => setRestoreCode(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={restoring}
                  onClick={() => {
                    setShowRestore(false);
                    setRestoreCode('');
                  }}
                >
                  {copy.cancel}
                </Button>
                <Button disabled={restoring || !restoreCode.trim()} onClick={restore}>
                  {restoring ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                  {copy.restoreConfirm}
                </Button>
              </div>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="text-destructive break-words text-sm">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-muted-foreground text-sm">
            {notice}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
