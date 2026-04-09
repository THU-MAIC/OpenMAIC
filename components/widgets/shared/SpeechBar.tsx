'use client';

import { Volume2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SpeechBarProps {
  text: string;
  onClose?: () => void;
  onSpeak?: () => void;
  /** If true, add extra bottom margin to avoid Roundtable overlap */
  inPlaybackMode?: boolean;
}

export function SpeechBar({ text, onClose, onSpeak, inPlaybackMode }: SpeechBarProps) {
  return (
    <div className={`fixed left-4 right-4 md:left-auto md:right-4 md:max-w-md bg-white dark:bg-gray-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-4 z-[60] ${inPlaybackMode ? 'bottom-52' : 'bottom-4'}`}>
      <div className="flex items-start gap-3">
        <div className="shrink-0 size-8 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
          <Volume2 className="size-4 text-violet-600 dark:text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-700 dark:text-gray-300">{text}</p>
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" className="shrink-0 size-6" onClick={onClose}>
            <X className="size-3" />
          </Button>
        )}
      </div>
      {onSpeak && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="outline" onClick={onSpeak}>
            Read aloud
          </Button>
        </div>
      )}
    </div>
  );
}