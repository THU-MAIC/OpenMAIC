'use client';

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, Send, ChevronDown, ChevronUp } from 'lucide-react';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { Participant } from '@/lib/types/roundtable';

/** Touch presentation of Roundtable's existing state and callbacks, with no engine. */
export function MobileRoundtable({
  toolbar,
  participants,
  speakerId,
  speakerName,
  speech,
  status,
  input,
  onInput,
  onInputActivate,
  onSend,
  onVoice,
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
  readonly participants: Participant[];
  readonly speakerId?: string | null;
  readonly speakerName: string;
  readonly speech: string;
  readonly status: string;
  readonly input: string;
  readonly onInput: (value: string) => void;
  readonly onInputActivate?: () => void;
  readonly onSend: () => void;
  readonly onVoice: () => void;
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
  const composer = (
    <form
      className="mobile-roundtable-input"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        rows={1}
        value={input}
        onFocus={onInputActivate}
        onChange={(event) => onInput(event.target.value)}
        placeholder={t('roundtable.inputPlaceholder')}
        aria-label={t('roundtable.inputPlaceholder')}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <button
        type="button"
        disabled={!voiceAvailable || processing}
        onClick={onVoice}
        aria-pressed={recording}
        aria-label={t(recording ? 'roundtable.stopRecording' : 'roundtable.voiceInput')}
      >
        {voiceAvailable ? <Mic size={19} /> : <MicOff size={19} />}
      </button>
      <button
        type="submit"
        disabled={sendDisabled || !input.trim()}
        aria-label={t('mobileClassroom.send')}
      >
        <Send size={19} />
      </button>
    </form>
  );
  return (
    <section className="mobile-roundtable" data-testid="mobile-roundtable" data-focused={focused}>
      <div className="mobile-roundtable-toolbar">{toolbar}</div>
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
        <div className="mobile-roundtable-roles">
          {participants.map((participant) => (
            <button
              key={participant.id}
              type="button"
              className="mobile-roundtable-role"
              data-speaking={participant.id === speakerId}
              onClick={() =>
                participant.role === 'user' ? onOpenChat?.() : setSelected(participant)
              }
              aria-label={participant.name}
            >
              <span className="mobile-roundtable-avatar">
                <AvatarDisplay src={participant.avatar} alt={participant.name} />
              </span>
              <span>{participant.name}</span>
            </button>
          ))}
        </div>
        {(speech || status) && (
          <button className="mobile-roundtable-speech" type="button" onClick={onOpenChat}>
            <span className="mobile-roundtable-speaker">{speakerName}</span>
            <span className="mobile-roundtable-status">{status}</span>
            <span className="mobile-roundtable-text">{speech}</span>
          </button>
        )}
        {discussion}
        {quickReplies}
        {referencePill}
        {composerHost ? createPortal(composer, composerHost) : composer}
      </div>
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
