'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic,
  Square,
  LoaderCircle,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  ChevronRight,
} from 'lucide-react';
import { DEFAULT_STUDENT_AVATAR, DEFAULT_TEACHER_AVATAR } from './constants';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import type { ChatAreaRef, SpeechSource } from '@/components/chat/chat-area';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { Participant } from '@/lib/types/roundtable';

/** Touch presentation of Roundtable's existing state and callbacks, with no engine. */
export function MobileRoundtable({
  toolbar,
  nav,
  userAvatar,
  participants,
  speakerId,
  speakerName,
  speech,
  speechSource,
  onRevealSpeech,
  status,
  input,
  onInput,
  onInputActivate,
  onSend,
  onQuestionFocus,
  onVoice,
  onFinishVoice,
  starting,
  voiceAvailable,
  recording,
  processing,
  sendDisabled,
  focused,
  onToggleFocus,
  onOpenChat,
  quickReplies,
  referencePill,
  discussion,
  participantDescription,
  composerHost,
  dialogContainer,
}: {
  readonly composerHost?: HTMLElement | null;
  readonly dialogContainer?: HTMLElement | null;
  readonly toolbar: ReactNode;
  /** Classroom / directory / notes / chat tabs. */
  readonly nav?: ReactNode;
  readonly userAvatar?: string;
  readonly participants: Participant[];
  readonly speakerId?: string | null;
  readonly speakerName: string;
  readonly speech: string;
  readonly speechSource: SpeechSource;
  readonly onRevealSpeech?: ChatAreaRef['revealSpeech'];
  readonly status: string;
  readonly input: string;
  readonly onInput: (value: string) => void;
  readonly onInputActivate?: () => void;
  readonly onSend: () => void;
  readonly onQuestionFocus?: () => void;
  readonly onVoice: () => void;
  readonly onFinishVoice: () => void;
  readonly starting: boolean;
  readonly voiceAvailable: boolean;
  readonly recording: boolean;
  readonly processing: boolean;
  readonly sendDisabled: boolean;
  readonly focused: boolean;
  readonly onToggleFocus: () => void;
  readonly onOpenChat?: () => void;
  readonly quickReplies: ReactNode;
  readonly referencePill: ReactNode;
  readonly discussion: ReactNode;
  readonly participantDescription: (id: string) => string | undefined;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Participant | null>(null);
  const [fullSpeech, setFullSpeech] = useState<{ speaker: string; text: string } | null>(null);
  const rolesRef = useRef<HTMLDivElement>(null);
  const speechRef = useRef<HTMLButtonElement>(null);
  const activeId =
    speakerId ?? participants.find((p) => p.role !== 'user' && p.name === speakerName)?.id ?? null;
  const hasSpeech = Boolean(speech || status);
  // Point the speech bubble at the speaker's card, keeping that card in view.
  // Written straight to the bubble so scrolling the roster never re-renders.
  useLayoutEffect(() => {
    const roles = rolesRef.current;
    const bubble = speechRef.current;
    if (!roles || !bubble) return;
    const card = activeId
      ? roles.querySelector<HTMLElement>(`[data-participant-id="${CSS.escape(activeId)}"]`)
      : null;
    if (!card) {
      bubble.dataset.hasTip = 'false';
      return;
    }
    const update = () => {
      bubble.style.setProperty(
        '--tip-x',
        `${card.offsetLeft - roles.offsetLeft - roles.scrollLeft + card.offsetWidth / 2}px`,
      );
      bubble.dataset.hasTip = 'true';
    };
    if (speakerId) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    update();
    roles.addEventListener('scroll', update, { passive: true });
    return () => roles.removeEventListener('scroll', update);
  }, [activeId, speakerId, participants, hasSpeech]);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clearHold = () => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  useEffect(() => clearHold, []);
  const voiceActive = recording || processing;
  const composer = (
    <form
      className="mobile-roundtable-input"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        hidden={voiceActive}
        rows={1}
        value={input}
        onFocus={() => {
          onQuestionFocus?.();
          onInputActivate?.();
        }}
        onChange={(event) => onInput(event.target.value)}
        placeholder={t('mobileClassroom.askTeacher')}
        aria-label={t('mobileClassroom.askTeacher')}
      />
      <span role="status" className="mobile-voice-status">
        {recording && <span aria-hidden="true" className="mobile-recording-dot" />}
        {processing && (
          <LoaderCircle aria-hidden="true" size={17} className="motion-safe:animate-spin" />
        )}
        {voiceActive && t(recording ? 'settings.recording' : 'settings.transcribing')}
      </span>
      {(voiceAvailable || recording || starting) && (
        <button
          type="button"
          className="mobile-voice-control"
          data-recording={recording}
          hidden={processing}
          disabled={!recording && !voiceAvailable}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            held.current = false;
            if (recording || starting) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            holdTimer.current = setTimeout(() => {
              held.current = true;
              onVoice();
            }, 350);
          }}
          onPointerUp={(event) => {
            if (!event.isPrimary) return;
            clearHold();
            if (held.current) onFinishVoice();
          }}
          onPointerCancel={() => {
            clearHold();
            if (held.current) onFinishVoice();
          }}
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => {
            if (!starting && (!held.current || event.detail === 0)) onVoice();
            held.current = false;
          }}
          aria-label={t(recording ? 'roundtable.stopRecording' : 'roundtable.voiceInput')}
        >
          {recording ? (
            <>
              <Square size={14} fill="currentColor" />
              {t('roundtable.stopRecording')}
            </>
          ) : (
            <Mic size={19} />
          )}
        </button>
      )}
      <button
        hidden={voiceActive}
        type="submit"
        disabled={sendDisabled || !input.trim()}
        aria-label={t('mobileClassroom.send')}
      >
        <ArrowUp size={21} />
      </button>
    </form>
  );
  return (
    <section className="mobile-roundtable" data-testid="mobile-roundtable" data-focused={focused}>
      <div className="mobile-roundtable-toolbar">{toolbar}</div>
      {nav}
      <button
        className="mobile-roundtable-fold"
        type="button"
        onClick={onToggleFocus}
        aria-expanded={!focused}
        aria-label={t('mobileClassroom.roundtable')}
      >
        {focused ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
      <div className="mobile-roundtable-content" hidden={focused}>
        <div className="mobile-roundtable-roles" ref={rolesRef}>
          {participants.map((participant) => {
            const isUser = participant.role === 'user';
            const avatar =
              (isUser && userAvatar) ||
              participant.avatar ||
              (participant.role === 'teacher' ? DEFAULT_TEACHER_AVATAR : DEFAULT_STUDENT_AVATAR);
            const speaking = participant.id === speakerId;
            return (
              <button
                key={participant.id}
                type="button"
                className="mobile-roundtable-role"
                data-participant-id={participant.id}
                data-speaking={speaking}
                data-active={participant.id === activeId}
                data-role={participant.role}
                onClick={() => (isUser ? onOpenChat?.() : setSelected(participant))}
                aria-label={isUser ? t('mobileClassroom.me') : participant.name}
              >
                <span className="mobile-roundtable-avatar">
                  <AvatarDisplay
                    src={avatar}
                    alt={isUser ? t('mobileClassroom.me') : participant.name}
                  />
                </span>
                <strong>{isUser ? t('mobileClassroom.me') : participant.name}</strong>
                <small className="mobile-roundtable-role-label">
                  {speaking && (
                    <i className="mobile-roundtable-wave" aria-hidden>
                      <b />
                      <b />
                      <b />
                    </i>
                  )}
                  {isUser
                    ? t('mobileClassroom.listening')
                    : t(`settings.agentRoles.${participant.role}`)}
                </small>
              </button>
            );
          })}
        </div>
        {hasSpeech && (
          <button
            ref={speechRef}
            className="mobile-roundtable-speech"
            type="button"
            disabled={!speech}
            onClick={() => {
              if (!onRevealSpeech?.(speechSource, speech))
                setFullSpeech({ speaker: speakerName, text: speech });
            }}
          >
            <span className="mobile-roundtable-speaker">{speakerName}</span>
            {!voiceActive && <span className="mobile-roundtable-status">{status}</span>}
            <span className="mobile-roundtable-text">{speech}</span>
            {speech && (
              <span className="mobile-roundtable-full-speech">
                {t(
                  speechSource === 'lecture'
                    ? 'mobileClassroom.viewInNotes'
                    : 'mobileClassroom.viewInChat',
                )}
                <ChevronRight size={12} />
              </span>
            )}
          </button>
        )}
        {discussion}
        {quickReplies}
        {referencePill}
        {composerHost ? createPortal(composer, composerHost) : composer}
      </div>
      <Dialog
        open={!!fullSpeech}
        onOpenChange={(open) => {
          if (!open) setFullSpeech(null);
        }}
      >
        <DialogContent container={dialogContainer} className="z-[400]" overlayClassName="z-[399]">
          <DialogTitle>
            {fullSpeech?.speaker} · {t('mobileClassroom.fullSpeech')}
          </DialogTitle>
          <p className="max-h-[55dvh] overflow-y-auto whitespace-pre-wrap break-words">
            {fullSpeech?.text}
          </p>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent container={dialogContainer} className="z-[400]" overlayClassName="z-[399]">
          <DialogTitle>{selected?.name}</DialogTitle>
          <p className="text-sm text-muted-foreground whitespace-pre-line">
            {selected ? participantDescription(selected.id) : ''}
          </p>
        </DialogContent>
      </Dialog>
    </section>
  );
}
