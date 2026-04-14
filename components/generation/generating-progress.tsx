'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, CheckCircle2, XCircle, Circle, Copy, Play } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

interface GeneratingProgressProps {
  outlineReady: boolean; // Is outline generation complete?
  firstPageReady: boolean; // Is first page generated?
  statusMessage: string;
  error?: string | null;
}

// Status item component - declared outside main component
function StatusItem({
  completed,
  inProgress,
  hasError,
  label,
}: {
  completed: boolean;
  inProgress: boolean;
  hasError: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-shrink-0">
        {hasError ? (
          <XCircle className="size-6 text-destructive" />
        ) : completed ? (
          <CheckCircle2 className="size-6 text-green-500" />
        ) : inProgress ? (
          <Loader2 className="size-6 text-primary animate-spin" />
        ) : (
          <Circle className="size-6 text-muted-foreground" />
        )}
      </div>
      <span
        className={`text-base ${
          hasError
            ? 'text-destructive'
            : completed
              ? 'text-green-600 font-medium'
              : inProgress
                ? 'text-primary font-medium'
                : 'text-muted-foreground'
        }`}
      >
        {label}
      </span>
    </div>
  );
}

export function GeneratingProgress({
  outlineReady,
  firstPageReady,
  statusMessage,
  error,
}: GeneratingProgressProps) {
  const { t } = useI18n();
  const [dots, setDots] = useState('');
  const [manualResponse, setManualResponse] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Extract hash and prompt
  const isManualIntervention = error?.startsWith('MANUAL_INTERVENTION_REQUIRED|||');
  const errorParts = isManualIntervention ? error?.split('|||') : [];
  const promptHash = (errorParts && errorParts[1]) || '';
  const manualPromptText = (errorParts && errorParts[2]) || '';

  // Animated dots for loading state
  useEffect(() => {
    if (!error && !firstPageReady) {
      const interval = setInterval(() => {
        setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
      }, 500);
      return () => clearInterval(interval);
    }
  }, [error, firstPageReady]);

  const handleCopyPrompt = () => {
    if (manualPromptText) {
      navigator.clipboard.writeText(manualPromptText);
      toast.success("Prompt copied to clipboard");
    }
  };

  const handleSubmitManualResponse = async () => {
    setIsSubmitting(true);
    try {
      await fetch('/api/manual-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: promptHash, response: manualResponse })
      });

      // Reload the page. The user will click "Generate" again,
      // but the backend will instantly skip the step using the cache!
      toast.success("Saved! Please restart the generation.");
      window.location.reload();
    } catch (_e) {
      toast.error("Failed to save response.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {isManualIntervention ? (
               <><XCircle className="size-5 text-amber-500" /> Action Required: Gemini Blocked Output</>
            ) : error ? (
              <>
                <XCircle className="size-5 text-destructive" />
                {t('generation.generationFailed')}
              </>
            ) : firstPageReady ? (
              <>
                <CheckCircle2 className="size-5 text-green-500" />
                {t('generation.openingClassroom')}
              </>
            ) : (
              <>
                <Loader2 className="size-5 animate-spin" />
                {t('generation.generatingCourse')}
                {dots}
              </>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isManualIntervention ? (
             <div className="space-y-4 bg-amber-500/10 border border-amber-500/20 p-4 rounded-lg">
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  The API blocked this specific prompt. Copy the text, paste it into the Gemini Web App, and paste the JSON result here.
                </p>
                <div className="relative">
                  <Textarea value={manualPromptText} readOnly className="h-48 text-xs font-mono bg-background/50" />
                  <Button size="sm" variant="secondary" className="absolute top-2 right-2" onClick={handleCopyPrompt}>
                    <Copy className="size-4 mr-2" /> Copy Prompt
                  </Button>
                </div>
                <div className="pt-4 border-t border-amber-500/20">
                  <Textarea
                    placeholder="Paste the JSON response from Gemini here..."
                    value={manualResponse}
                    onChange={(e) => setManualResponse(e.target.value)}
                    className="h-32 text-xs font-mono"
                  />
                  <Button className="mt-2 w-full" disabled={!manualResponse || isSubmitting} onClick={handleSubmitManualResponse}>
                    <Play className="size-4 mr-2" /> Inject & Restart Generation
                  </Button>
                </div>
             </div>
          ) : (
            <>
              {/* Two milestone status items */}
              <div className="divide-y">
                <StatusItem
                  completed={outlineReady}
                  inProgress={!outlineReady && !error}
                  hasError={!outlineReady && !!error}
                  label={
                    outlineReady ? t('generation.outlineReady') : t('generation.generatingOutlines')
                  }
                />
                <StatusItem
                  completed={firstPageReady}
                  inProgress={outlineReady && !firstPageReady && !error}
                  hasError={outlineReady && !firstPageReady && !!error}
                  label={
                    firstPageReady
                      ? t('generation.firstPageReady')
                      : t('generation.generatingFirstPage')
                  }
                />
              </div>

              {/* Status message */}
              {statusMessage && !error && (
                <div className="pt-2 border-t">
                  <p className="text-sm text-muted-foreground">{statusMessage}</p>
                </div>
              )}

              {/* Error message */}
              {error && (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
