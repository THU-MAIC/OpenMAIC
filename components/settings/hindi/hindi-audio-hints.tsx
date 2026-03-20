'use client';

import { Info } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

export function HindiAudioHints() {
  const { locale } = useI18n();

  if (locale !== 'hi-IN') return null;

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/70 dark:border-sky-800 dark:bg-sky-950/30 p-4 text-sm text-sky-900 dark:text-sky-200">
      <div className="flex items-start gap-2">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">Hindi audio defaults enabled</p>
          <p className="mt-1 text-sky-800/80 dark:text-sky-200/80">
            TTS will prefer Google Cloud TTS with hi-IN-Neural2-A, and ASR will prefer browser recognition with hi-IN.
          </p>
        </div>
      </div>
    </div>
  );
}
