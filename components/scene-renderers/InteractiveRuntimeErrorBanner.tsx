'use client';

import { useState } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/hooks/use-i18n';

/**
 * Host-side notice for an interactive scene whose iframe already reported a
 * runtime error. It sits over the iframe chrome, outside the sandbox, so the
 * generated page cannot hide or rewrite it.
 *
 * Who is looking decides what it says (issue #2329): someone who can repair
 * the course gets a plain-language notice with the raw errors folded into a
 * collapsed "technical details" section and the "Fix with agent" hand-off;
 * everyone else — learners, viewers of a shared course — gets a neutral
 * placeholder that never shows the raw error or any repair action. The page
 * itself stays visible underneath in both cases: a page that threw is often
 * still partly working, and hiding it would hide what works.
 */
export function InteractiveRuntimeErrorBanner({
  errors,
  repairable,
  fixEnabled,
  onFix,
  onDismiss,
}: {
  /** Every observed error for this scene, oldest first. */
  readonly errors: readonly string[];
  /** Whether this viewer may repair the course (and so sees the details). */
  readonly repairable: boolean;
  /** Whether this build has a workspace to hand the error off to. */
  readonly fixEnabled: boolean;
  readonly onFix: () => void;
  readonly onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div
      data-testid="interactive-runtime-error"
      data-repairable={repairable ? 'true' : 'false'}
      className="pointer-events-auto absolute inset-x-3 bottom-3 z-10"
    >
      <Alert variant="destructive" className="px-3 py-2 shadow-lg">
        <AlertTitle>
          {t(
            repairable
              ? 'chat.interactiveRuntimeError.title'
              : 'chat.interactiveRuntimeError.neutralTitle',
          )}
        </AlertTitle>
        {repairable ? (
          <>
            <AlertDescription>
              {t('chat.interactiveRuntimeError.ownerDescription')}
            </AlertDescription>
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="interactive-runtime-error-details-toggle"
                  aria-expanded={detailsOpen}
                >
                  {t('chat.interactiveRuntimeError.technicalDetails')}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre
                  data-testid="interactive-runtime-error-details"
                  className="mt-1 max-h-32 overflow-y-auto rounded-md bg-gray-950/80 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-gray-100"
                >
                  {errors.join('\n')}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </>
        ) : (
          <AlertDescription>
            {t('chat.interactiveRuntimeError.neutralDescription')}
          </AlertDescription>
        )}
        <AlertAction>
          {repairable && fixEnabled ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="interactive-runtime-error-fix"
              onClick={onFix}
            >
              {t('chat.interactiveRuntimeError.fixWithAgent')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="interactive-runtime-error-dismiss"
            onClick={onDismiss}
          >
            {t('chat.interactiveRuntimeError.dismiss')}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
