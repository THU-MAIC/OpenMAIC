'use client';
import { LoaderCircle, Mic, MicOff } from 'lucide-react';
import { toast } from 'sonner';
import { useASRAvailable } from '@/lib/hooks/use-asr-available';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

/**
 * Speaking instead of typing, beside a send button. The button itself shows what is going on:
 * lit while listening, turning while the words are worked out. What was heard is handed back
 * to go into the input, where it can be read and changed before it is sent.
 */
export function VoiceInputButton({
  disabled = false,
  onSpoken,
  className,
}: {
  /** Nothing can be sent now; a recording already under way can still be ended. */
  disabled?: boolean;
  onSpoken: (text: string) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const available = useASRAvailable();
  const { isRecording, isProcessing, startRecording, stopRecording } = useAudioRecorder({
    onTranscription: (spoken) => {
      if (!spoken.trim()) {
        toast.info(t('roundtable.noSpeechDetected'));
        return;
      }
      onSpoken(spoken.trim());
    },
  });
  const label = t(
    !available
      ? 'roundtable.voiceInputDisabled'
      : isRecording
        ? 'roundtable.stopRecording'
        : 'roundtable.voiceInput',
  );
  return (
    <button
      type="button"
      data-testid="pbl-voice-input"
      data-recording={isRecording || undefined}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40',
        // A tinted halo while it listens: lit, yet not to be taken for the solid send button.
        isRecording &&
          'bg-primary/15 text-primary ring-2 ring-primary/40 hover:bg-primary/20 hover:text-primary',
        className,
      )}
      aria-label={label}
      aria-pressed={isRecording}
      title={label}
      disabled={!available || isProcessing || (disabled && !isRecording)}
      onClick={() => (isRecording ? stopRecording() : startRecording())}
    >
      {isProcessing ? (
        <LoaderCircle size={16} className="animate-spin" />
      ) : available ? (
        <Mic size={16} />
      ) : (
        <MicOff size={16} />
      )}
    </button>
  );
}
