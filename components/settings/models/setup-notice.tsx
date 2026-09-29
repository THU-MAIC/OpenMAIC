'use client';

import { useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

import type { SetupOutcome } from './first-run-setup';
import { MS } from './slot-meta';

type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * A first-run setup that added its provider but did not assign it: says which
 * provider was added and why nothing was assigned, and offers the way on (try
 * the assignment again, or add the provider's models).
 */
export function SetupNotice({
  outcome,
  onRetry,
  onProviders,
  onDismiss,
  t,
}: {
  outcome: SetupOutcome;
  onRetry: () => Promise<void>;
  onProviders: () => void;
  onDismiss: () => void;
  t: T;
}) {
  const [retrying, setRetrying] = useState(false);
  if (outcome.result.status !== 'partial') return null;
  const { reason, message } = outcome.result;
  const name = outcome.preset.name;
  // Without a reason the provider simply lists no language model to assign.
  const noModel = reason === undefined;
  // Whether the provider was added is not known yet, or it turned out it was not.
  const unknownAdd = reason === 'unconfirmed-add';
  const notAdded = reason === 'not-added';
  const why =
    reason === 'conflict' || reason === 'locked'
      ? t(`${MS}.setup.changedMeanwhile`)
      : reason === 'unconfirmed'
        ? t(`${MS}.setup.answerLost`)
        : (message ?? '');

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-amber-200/70 bg-amber-50/60 px-3.5 py-2.5 dark:border-amber-800/50 dark:bg-amber-950/20"
    >
      <AlertCircle
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-relaxed">
          {noModel
            ? t(`${MS}.setup.noModel`, { name })
            : unknownAdd
              ? t(`${MS}.setup.unconfirmedAdd`, { name })
              : notAdded
                ? t(`${MS}.setup.notAdded`, { name })
                : t(`${MS}.setup.partial`, { name, message: why })}
        </p>
        <div className={notAdded ? 'hidden' : 'mt-2 flex flex-wrap gap-2'}>
          {noModel ? (
            <Button size="xs" variant="outline" onClick={onProviders}>
              {t(`${MS}.setup.openProviders`)}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await onRetry();
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
              {unknownAdd ? t(`${MS}.setup.checkAgain`) : t(`${MS}.setup.retry`)}
            </Button>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t(`${MS}.setup.dismiss`)}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
