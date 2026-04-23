'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Mic, MicOff, Loader2 } from 'lucide-react';
import type { CEFRLevel, ExerciseCard } from '@/lib/types/stage';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface TeacherChatProps {
  cefrLevel: CEFRLevel;
  grammarPoint: string;
  topic: string;
  card: ExerciseCard;
  // Resets chat when card changes
  cardKey: string;
  /** BCP-47 code for the language being taught (e.g. 'lt-LT'). Forwarded to the chat API. */
  targetLanguage?: string;
  /** BCP-47 code for the learner's base language (e.g. 'en-US', 'es-ES'). Forwarded to the chat API. */
  explanationLanguage?: string;
}

function getCardPhrase(card: ExerciseCard): string | undefined {
  if ('phrase' in card) return card.phrase?.lithuanian ?? '';
  if ('target' in card) return card.target?.lithuanian ?? '';
  if ('word' in card) return card.word?.lithuanian ?? '';
  if ('source' in card && card.source && 'lithuanian' in card.source) return card.source.lithuanian;
  return undefined;
}

function getCardAnswer(card: ExerciseCard): string | undefined {
  if ('answer' in card) return card.answer;
  if ('expected' in card) return card.expected;
  return undefined;
}

const isEarlyLevel = (level: CEFRLevel) => level === 'A1' || level === 'A2';

export function TeacherChat({ cefrLevel, grammarPoint, topic, card, cardKey, targetLanguage, explanationLanguage }: TeacherChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Reset on card change
  useEffect(() => {
    setMessages([]);
    setInput('');
  }, [cardKey]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userMsg: Message = { role: 'user', content: text.trim() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/lesson-plan-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next,
          cardContext: {
            kind: card.kind,
            cefrLevel,
            phrase: getCardPhrase(card),
            answer: getCardAnswer(card),
            grammarPoint,
            topic,
            ...(targetLanguage ? { targetLanguage } : {}),
            ...(explanationLanguage ? { explanationLanguage } : {}),
          },
        }),
      });

      if (!res.ok || !res.body) throw new Error('Stream failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';

      setMessages((m) => [...m, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        assistantText += chunk;
        setMessages((m) => {
          const updated = [...m];
          updated[updated.length - 1] = { role: 'assistant', content: assistantText };
          return updated;
        });
      }
    } catch (err) {
      console.error('Chat error:', err);
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, isLoading, card, cefrLevel, grammarPoint, topic, targetLanguage, explanationLanguage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const toggleRecording = async () => {
    if (isRecording) {
      mediaRef.current?.stop();
      setIsRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'recording.webm');
        form.append('language', targetLanguage ?? 'lt-LT');
        try {
          const res = await fetch('/api/transcription', { method: 'POST', body: form });
          if (res.ok) {
            const { text } = await res.json();
            if (text?.trim()) sendMessage(text.trim());
          }
        } catch {
          // transcription failed silently
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch {
      // mic permission denied
    }
  };

  const showVoice = !isEarlyLevel(cefrLevel);
  const placeholder = isEarlyLevel(cefrLevel)
    ? 'Ask your teacher...'
    : 'Answer in the target language or ask a question...';

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-900">
      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center px-4">
              {isEarlyLevel(cefrLevel)
                ? 'Your teacher is here to help! Ask a question or try the exercise.'
                : 'Practice with your teacher. Answer the exercise or ask questions in the target language.'}
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
                msg.role === 'user'
                  ? 'bg-blue-500 text-white rounded-br-sm'
                  : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200/60 dark:border-gray-700/60 rounded-bl-sm shadow-sm'
              }`}
            >
              {msg.content || (
                <span className="flex gap-1 items-center text-gray-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span className="text-xs">Thinking...</span>
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="shrink-0 flex gap-2 px-3 py-3 border-t border-gray-200/60 dark:border-gray-700/60 bg-white dark:bg-gray-800"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={isLoading}
          className="flex-1 text-sm bg-gray-100 dark:bg-gray-700 rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-blue-400/50 text-gray-900 dark:text-gray-100 placeholder-gray-400 disabled:opacity-50"
        />
        {showVoice && (
          <button
            type="button"
            onClick={toggleRecording}
            className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
              isRecording
                ? 'bg-red-500 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
        )}
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="shrink-0 w-9 h-9 rounded-xl bg-blue-500 text-white flex items-center justify-center hover:bg-blue-600 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
    </div>
  );
}
