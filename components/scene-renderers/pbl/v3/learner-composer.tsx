'use client';
import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { SpeechButton } from '@/components/audio/speech-button';
import { useCallback, useLayoutEffect, useRef } from 'react';

function fitMessageField(field: HTMLTextAreaElement) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

/**
 * Where the learner writes to the role: the same box in the conversation and under the
 * companion's bubble. While the role has the floor its send button stops the reply instead.
 */
export function LearnerComposer({
  id,
  text,
  onTextChange,
  speechActive,
  onSpeechActiveChange,
  onSend,
  busy = false,
  onStop,
  stopDisabled = false,
  sending = false,
  disabled = false,
  blockedTitle,
  describedBy,
  voice = false,
  compact = false,
  classic = false,
  className,
}: {
  id: string;
  text: string;
  onTextChange: (update: React.SetStateAction<string>) => void;
  speechActive: boolean;
  onSpeechActiveChange: (active: boolean) => void;
  onSend: () => void;
  /** The role is replying: the send button becomes the way to stop it. */
  busy?: boolean;
  onStop?: () => void;
  stopDisabled?: boolean;
  /** The learner's message is on its way. */
  sending?: boolean;
  /** Nothing can be sent now. */
  disabled?: boolean;
  /** Why not, said on the send button. */
  blockedTitle?: string;
  describedBy?: string;
  /** Offer speaking beside typing. */
  voice?: boolean;
  /** A shorter box, for under the bubble. */
  compact?: boolean;
  /** The docked assistant's original box, kept where the role is not a companion. */
  classic?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const observeComposer = useCallback((field: HTMLTextAreaElement | null) => {
    composerRef.current = field;
    if (!field || typeof ResizeObserver === 'undefined') return;
    let lastWidth = 0;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.borderBoxSize[0].inlineSize;
      if (width === lastWidth) return;
      lastWidth = width;
      cancelAnimationFrame(frame);
      if (width > 0) frame = requestAnimationFrame(() => fitMessageField(field));
    });
    observer.observe(field, { box: 'border-box' });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      composerRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (composerRef.current) fitMessageField(composerRef.current);
  }, [text]);
  const send = () => {
    if (!disabled && !busy && !speechActive && text.trim()) onSend();
  };
  const voiceButton = voice && (
    <SpeechButton
      size="md"
      continuous
      className={classic ? undefined : 'rounded-full'}
      disabled={disabled || busy}
      onActiveChange={onSpeechActiveChange}
      onTranscription={(transcript) => {
        const said = transcript.trim();
        if (!said) return;
        onTextChange((draft) => (draft && !/\s$/.test(draft) ? `${draft} ${said}` : draft + said));
        composerRef.current?.focus();
      }}
    />
  );
  const action =
    busy && onStop ? (
      <button
        type="button"
        data-stop
        className={cn(
          'rounded-full bg-red-600 text-white hover:bg-red-700 disabled:opacity-40',
          classic ? 'p-2' : 'flex size-8 shrink-0 items-center justify-center',
        )}
        aria-label={t('pblV3.cancel')}
        title={t('pblV3.cancel')}
        disabled={stopDisabled}
        onClick={onStop}
      >
        <Square size={classic ? 15 : 12} className={classic ? undefined : 'fill-current'} />
      </button>
    ) : (
      <button
        type="button"
        className={cn(
          'rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40',
          classic ? 'p-2' : 'flex size-8 shrink-0 items-center justify-center',
        )}
        aria-label={t('pblV3.send')}
        aria-busy={sending}
        disabled={disabled || busy || speechActive || !text.trim()}
        title={blockedTitle}
        aria-describedby={describedBy}
        onClick={send}
      >
        {sending ? <LoaderCircle size={16} className="animate-spin" /> : <ArrowUp size={16} />}
      </button>
    );
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  if (classic)
    return (
      <>
        <label className="sr-only" htmlFor={id}>
          {t('pblV3.message')}
        </label>
        <div
          data-testid="pbl-learner-composer"
          className={cn(
            'rounded-xl border bg-muted/20 p-2 focus-within:ring-1 focus-within:ring-primary',
            className,
          )}
        >
          <textarea
            id={id}
            ref={observeComposer}
            rows={1}
            className="max-h-40 min-h-[52px] w-full resize-none overflow-y-auto bg-transparent p-1 text-sm outline-none"
            placeholder={t('pblV3.ide.messagePlaceholder')}
            value={text}
            aria-describedby={describedBy}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">{t('pblV3.ide.sendHint')}</span>
            <div className="flex items-center gap-1">
              {voiceButton}
              {action}
            </div>
          </div>
        </div>
      </>
    );
  // One line to begin with, growing with what is written; speaking and sending sit beside it.
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {t('pblV3.message')}
      </label>
      <div
        data-testid="pbl-learner-composer"
        className={cn(
          'flex items-end gap-1 rounded-2xl border bg-background py-1.5 pe-1.5 ps-3.5 transition-colors focus-within:border-primary/70',
          className,
        )}
      >
        <textarea
          id={id}
          rows={1}
          ref={observeComposer}
          className={cn(
            'max-h-40 min-w-0 flex-1 resize-none self-center bg-transparent py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/70',
            !compact && 'min-h-[3.25rem]',
          )}
          placeholder={t('pblV3.ide.messagePlaceholder')}
          value={text}
          aria-describedby={describedBy}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {voiceButton}
        {action}
      </div>
    </>
  );
}
