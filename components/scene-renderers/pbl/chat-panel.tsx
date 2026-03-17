'use client';

import { useState, useRef, useEffect } from 'react';
import { ArrowUp } from 'lucide-react';
import type { PBLChatMessage, PBLIssue } from '@/lib/pbl/types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { MessageResponse } from '@/components/ai-elements/message';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';

interface ChatPanelProps {
  readonly messages: PBLChatMessage[];
  readonly currentIssue: PBLIssue | null;
  readonly userRole: string;
  readonly isLoading: boolean;
  readonly onSendMessage: (text: string) => void;
}

export function ChatPanel({
  messages,
  currentIssue,
  userRole,
  isLoading,
  onSendMessage,
}: ChatPanelProps) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  // Draft cache
  const {
    cachedValue: cachedDraft,
    updateCache: updateDraftCache,
    clearCache: clearDraftCache,
  } = useDraftCache<string>({ key: 'pblChatDraft' });

  // Restore draft: use lazy initializer for first render, then sync via derived state
  const [prevCachedDraft, setPrevCachedDraft] = useState(cachedDraft);
  if (cachedDraft !== prevCachedDraft) {
    setPrevCachedDraft(cachedDraft);
    if (cachedDraft) {
      setInput(cachedDraft);
    }
  }

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleInputChange = (value: string) => {
    setInput(value);
    updateDraftCache(value);
  };

  const handleSubmit = () => {
    if (!input.trim() || isLoading) return;
    onSendMessage(input.trim());
    setInput('');
    clearDraftCache();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b">
        <h2 className="font-semibold text-sm">{t('pbl.chat.title')}</h2>
        {currentIssue && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('pbl.chat.currentIssue')}: {currentIssue.title}
          </p>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} isUser={msg.agent_name === userRole} />
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <div className="flex gap-1">
              <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
                .
              </span>
              <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
                .
              </span>
              <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
                .
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t p-3">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-2">
          <span>{t('pbl.chat.mentionHint')}</span>
        </div>
        <div className="flex gap-2 items-center">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder={t('pbl.chat.placeholder')}
            disabled={isLoading}
            rows={1}
            className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
          />
          <SpeechButton
            size="md"
            disabled={isLoading}
            onTranscription={(text) => {
              setInput((prev) => {
                const next = prev + (prev ? ' ' : '') + text;
                updateDraftCache(next);
                return next;
              });
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isLoading}
            className="shrink-0 h-8 w-8 rounded-lg flex items-center justify-center transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ message, isUser }: { message: PBLChatMessage; isUser: boolean }) {
  const isSystem = message.agent_name === 'System';

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="text-xs text-muted-foreground bg-muted/50 rounded-full px-3 py-1">
          {message.message}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <span className="text-[10px] font-medium text-muted-foreground mb-0.5 px-1">
        {message.agent_name}
      </span>
      <div
        className={`rounded-xl px-3 py-2 text-sm max-w-[85%] ${
          isUser ? 'bg-primary text-primary-foreground whitespace-pre-wrap' : 'bg-muted'
        }`}
      >
        {isUser ? message.message : <MessageResponse>{message.message}</MessageResponse>}
      </div>
    </div>
  );
}
