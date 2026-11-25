'use client';

import { useCallback, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Mic, Send } from 'lucide-react';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

const VOICE_WAVE_BARS = [
  { peak: 18, duration: 0.55 },
  { peak: 24, duration: 0.72 },
  { peak: 15, duration: 0.63 },
  { peak: 22, duration: 0.68 },
  { peak: 27, duration: 0.78 },
  { peak: 19, duration: 0.61 },
  { peak: 26, duration: 0.74 },
  { peak: 17, duration: 0.58 },
  { peak: 23, duration: 0.7 },
  { peak: 16, duration: 0.57 },
  { peak: 21, duration: 0.66 },
  { peak: 14, duration: 0.53 },
] as const;

export function VoiceWaveformBars({ barClassName }: { readonly barClassName: string }) {
  return VOICE_WAVE_BARS.map((bar, i) => (
    <motion.div
      key={i}
      animate={{
        height: [4, bar.peak, 4],
        opacity: [0.3, 1, 0.3],
      }}
      transition={{
        repeat: Infinity,
        duration: bar.duration,
        delay: i * 0.05,
        ease: 'easeInOut',
      }}
      className={cn('w-1 rounded-full', barClassName)}
    />
  ));
}

/**
 * The classroom's text input: one pill the learner types into, sent with Enter. Shared by
 * every surface where a learner answers a speaking agent.
 */
export function SpeechTextInput({
  value,
  onChange,
  onSend,
  sending = false,
  placeholder,
  panelClassName,
  onBeforeInput,
  onCompositionStart,
  onEscape,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  /** A send is in flight or cooling down; the button waits. */
  readonly sending?: boolean;
  readonly placeholder: string;
  readonly panelClassName?: string;
  readonly onBeforeInput?: () => void;
  readonly onCompositionStart?: () => void;
  readonly onEscape?: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 backdrop-blur-xl rounded-full px-4 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] border border-gray-200/60 dark:border-white/10',
        panelClassName,
      )}
    >
      <div className="flex-1 min-w-0 flex items-center">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBeforeInput={onBeforeInput}
          onCompositionStart={onCompositionStart}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
            if (e.key === 'Escape' && onEscape) onEscape();
          }}
          placeholder={placeholder}
          autoFocus
          rows={1}
          className="w-full resize-none bg-transparent border-none focus:ring-0 focus:outline-none outline-none shadow-none ring-0 text-gray-900 dark:text-white text-sm placeholder:text-gray-400 dark:placeholder:text-gray-400 py-0 leading-[40px] max-h-[80px]"
          style={{ fieldSizing: 'content' } as Record<string, string>}
        />
      </div>
      <button
        onClick={onSend}
        disabled={sending}
        className={cn(
          'w-10 h-10 rounded-full flex items-center justify-center transition-all shrink-0',
          sending
            ? 'bg-gray-500/50 cursor-not-allowed'
            : 'bg-purple-600 hover:bg-purple-700 shadow-[0_4px_16px_rgba(147,51,234,0.3)]',
        )}
      >
        {sending ? (
          <Loader2 className="w-4 h-4 text-white animate-spin" />
        ) : (
          <Send className="w-4 h-4 text-white" />
        )}
      </button>
    </div>
  );
}

/** The classroom's voice input: a live waveform, what it is doing, and the mic to stop. */
export function SpeechVoicePanel({
  recording,
  processing,
  onToggle,
  panelClassName,
}: {
  readonly recording: boolean;
  readonly processing: boolean;
  readonly onToggle: () => void;
  readonly panelClassName?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'flex items-center gap-4 backdrop-blur-xl rounded-full px-5 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] border border-gray-200/60 dark:border-white/10',
        panelClassName,
      )}
    >
      {/* Listening moves; working on what was heard is the same bars at rest, and the mic
          itself turns. */}
      <div className="flex items-center gap-0.5 h-8">
        {processing ? (
          VOICE_WAVE_BARS.map((_, i) => (
            <div
              key={i}
              className="h-1.5 w-1 rounded-full bg-purple-300/70 dark:bg-purple-400/40"
            />
          ))
        ) : (
          <VoiceWaveformBars barClassName="bg-gradient-to-t from-purple-400 to-indigo-400" />
        )}
      </div>
      <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-purple-600 dark:text-purple-300 uppercase">
        {processing ? t('roundtable.processing') : t('roundtable.listening')}
      </span>
      {/* Mic button */}
      <button
        type="button"
        aria-label={recording ? t('roundtable.stopRecording') : t('roundtable.startRecording')}
        className="relative group cursor-pointer bg-transparent border-none p-0"
        onClick={onToggle}
      >
        <div className="relative w-12 h-12 rounded-full bg-gradient-to-br from-purple-600 to-indigo-700 shadow-[0_4px_20px_rgba(147,51,234,0.3)] flex items-center justify-center group-hover:scale-105 transition-transform duration-300 border border-white/20">
          <Mic className={cn('w-5 h-5 text-white', processing && 'opacity-60')} />
        </div>
        {processing ? (
          <div
            data-testid="voice-processing-ring"
            className="absolute -inset-1.5 rounded-full border-2 border-purple-200 border-t-purple-600 animate-spin dark:border-purple-900 dark:border-t-purple-300"
          />
        ) : (
          <div className="absolute inset-0 rounded-full border-2 border-purple-500 opacity-40 animate-[ping_2s_ease-in-out_infinite]" />
        )}
      </button>
    </div>
  );
}

/**
 * Replies the learner could give, as a draft of their own bubble: the same slot, radius and
 * avatar placement as what they said, outlined instead of filled so it reads as "you could
 * say" rather than "you said".
 */
export function SuggestedReplies({
  labels,
  disabled = false,
  onPick,
  avatar,
  className,
  full = false,
}: {
  readonly labels: readonly string[];
  readonly disabled?: boolean;
  readonly onPick: (label: string) => void;
  readonly avatar: string;
  readonly className?: string;
  /** Show every reply instead of two rows that scroll, where there is room for them. */
  readonly full?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl rounded-br-sm border border-dashed border-purple-300 bg-[#faf7ff] pl-3 pr-5 py-2.5 dark:border-purple-400/50 dark:bg-[#1f1830]',
        className,
      )}
    >
      <div
        className="absolute -right-2.5 -top-2.5 z-20 pointer-events-none select-none"
        title={t('roundtable.you')}
      >
        <div className="w-6 h-6 rounded-full overflow-hidden border-2 border-purple-300 dark:border-purple-500 bg-white dark:bg-gray-900 shadow-sm">
          <AvatarDisplay src={avatar} alt={t('roundtable.you')} />
        </div>
      </div>
      <QuickReplyOptions labels={labels} disabled={disabled} onPick={onPick} full={full} />
    </div>
  );
}

export function QuickReplyOptions({
  labels,
  disabled = false,
  onPick,
  full = false,
}: {
  readonly labels: readonly string[];
  readonly disabled?: boolean;
  readonly onPick: (label: string) => void;
  readonly full?: boolean;
}) {
  const { t } = useI18n();
  // Fade the last visible row while more are scrolled below.
  const [clipped, setClipped] = useState(false);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    setClipped(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }, []);
  return (
    <div
      data-testid="cue-user-options"
      role="group"
      aria-label={t('roundtable.yourTurn')}
      ref={measure}
      onScroll={(event) => measure(event.currentTarget)}
      className={cn(
        'flex min-w-0 flex-wrap content-start gap-1.5',
        !full && 'max-h-[3.75rem] overflow-y-auto overscroll-contain scrollbar-hide',
        !full &&
          clipped &&
          '[mask-image:linear-gradient(to_bottom,#000_calc(100%-16px),transparent)]',
      )}
    >
      {labels.map((label, index) => (
        <button
          key={`${index}-${label}`}
          type="button"
          title={label}
          aria-label={label}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onPick(label);
          }}
          className="h-[1.6875rem] max-w-full shrink-0 truncate rounded-full border border-purple-200 bg-white px-3 @max-[36rem]:px-2 text-[13px] leading-[1.5625rem] text-purple-700 shadow-[0_1px_2px_rgba(88,28,135,0.06)] transition-colors hover:border-purple-400 hover:bg-purple-600 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple-500 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 dark:border-purple-700/70 dark:bg-gray-900/70 dark:text-purple-200 dark:hover:border-purple-400 dark:hover:bg-purple-500 dark:hover:text-white"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
