'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Volume2, Loader2 } from 'lucide-react';
import type { Stage, Scene, LessonPlanContent, CEFRLevel } from '@/lib/types/stage';
import { CardDispatch } from './card-dispatch';
import { TeacherChat } from './teacher-chat';

interface LessonPlanPlayerProps {
  stage: Stage;
  scene: Scene;
}

const CEFR_COLORS: Record<string, string> = {
  A1: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  A2: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  B1: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  B2: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  C1: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  C2: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
};

function getCardPhrase(card: LessonPlanContent['cards'][number]): string | undefined {
  if ('phrase' in card) return card.phrase.lithuanian;
  if ('target' in card) return card.target.lithuanian;
  if ('word' in card) return card.word.lithuanian;
  if ('source' in card && 'lithuanian' in card.source) return card.source.lithuanian;
  return undefined;
}

function getCardGroundingId(card: LessonPlanContent['cards'][number]): string | undefined {
  if ('groundingId' in card) return card.groundingId as string;
  return undefined;
}

function useTTS(phrase: string | undefined, language = 'lt-LT') {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cache = useRef<Record<string, string>>({});

  useEffect(() => {
    setAudioUrl(null);
    if (!phrase) return;
    if (cache.current[phrase]) {
      setAudioUrl(cache.current[phrase]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch('/api/generate/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: phrase, language }),
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        const url = URL.createObjectURL(blob);
        cache.current[phrase] = url;
        setAudioUrl(url);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [phrase, language]);

  return { audioUrl, loading };
}

export function LessonPlanPlayer({ stage, scene }: LessonPlanPlayerProps) {
  const content = scene.content as LessonPlanContent;
  const cards = content?.cards ?? [];
  const groundingMap = content?.groundingMap ?? {};

  const [cardIndex, setCardIndex] = useState(0);
  const currentCard = cards[cardIndex] ?? null;
  const cefrLevel = (content?.microGoal?.cefrLevel ?? 'A1') as CEFRLevel;
  const cefrColor = CEFR_COLORS[cefrLevel] ?? 'bg-gray-100 text-gray-600';

  const phrase = currentCard ? getCardPhrase(currentCard) : undefined;
  const gId = currentCard ? getCardGroundingId(currentCard) : undefined;
  const grounding = gId ? groundingMap[gId] : undefined;
  const imageUrl = grounding?.imageUrl;

  const { audioUrl, loading: ttsLoading } = useTTS(phrase, stage.language ?? 'lt-LT');

  const playAudio = () => {
    if (!audioUrl) return;
    new Audio(audioUrl).play().catch(() => {});
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 bg-white dark:bg-gray-800 border-b border-gray-200/60 dark:border-gray-700/60">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
            {stage.name}
          </h1>
          <span className={`shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${cefrColor}`}>
            {cefrLevel}
          </span>
        </div>
      </div>

      {/* Micro-goal banner */}
      {content?.microGoal && (content.microGoal.topic || content.microGoal.grammarPoint) && (
        <div className="shrink-0 px-6 py-2.5 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700/40">
          <div className="max-w-5xl mx-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            {content.microGoal.topic && (
              <span>
                <span className="font-medium text-gray-700 dark:text-gray-300">Topic:</span>{' '}
                {content.microGoal.topic}
              </span>
            )}
            {content.microGoal.grammarPoint && (
              <span>
                <span className="font-medium text-gray-700 dark:text-gray-300">Grammar:</span>{' '}
                {content.microGoal.grammarPoint}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Card column */}
        <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
          <div className="flex-1 px-6 py-6 max-w-2xl w-full mx-auto">
            {/* Card counter */}
            <p className="text-xs text-gray-400 dark:text-gray-500 font-medium mb-4 text-center tracking-wide uppercase">
              Card {cardIndex + 1} of {cards.length}
            </p>

            {/* Optional vocabulary image */}
            {imageUrl && (
              <div className="mb-4 rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-800 aspect-video flex items-center justify-center">
                <img
                  src={imageUrl}
                  alt={phrase ?? 'Vocabulary image'}
                  className="w-full h-full object-cover"
                />
              </div>
            )}

            {/* Card content */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200/60 dark:border-gray-700/60 p-6">
              {/* TTS play button */}
              {phrase && (
                <div className="flex justify-end mb-3">
                  <button
                    onClick={playAudio}
                    disabled={!audioUrl || ttsLoading}
                    className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    {ttsLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5" />
                    )}
                    Listen
                  </button>
                </div>
              )}

              {currentCard && (
                <CardDispatch
                  key={`${cardIndex}-${currentCard.kind}`}
                  card={currentCard}
                />
              )}
            </div>
          </div>

          {/* Navigation footer */}
          <div className="shrink-0 px-6 py-4 bg-white dark:bg-gray-800 border-t border-gray-200/60 dark:border-gray-700/60">
            <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
              <button
                onClick={() => setCardIndex((i) => Math.max(0, i - 1))}
                disabled={cardIndex === 0}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:pointer-events-none transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </button>

              {/* Progress dots */}
              <div className="flex gap-1.5 flex-wrap justify-center">
                {cards.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setCardIndex(i)}
                    className={`w-2 h-2 rounded-full transition-all ${
                      i === cardIndex
                        ? 'bg-blue-500 scale-125'
                        : i < cardIndex
                          ? 'bg-blue-200 dark:bg-blue-700'
                          : 'bg-gray-200 dark:bg-gray-600'
                    }`}
                  />
                ))}
              </div>

              <button
                onClick={() => setCardIndex((i) => Math.min(cards.length - 1, i + 1))}
                disabled={cardIndex === cards.length - 1}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:pointer-events-none transition-colors"
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Teacher chat column */}
        <div className="w-80 shrink-0 border-l border-gray-200/60 dark:border-gray-700/60 flex flex-col">
          <div className="shrink-0 px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-200/60 dark:border-gray-700/60">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Teacher
            </p>
          </div>
          <div className="flex-1 min-h-0">
            {currentCard && (
              <TeacherChat
                cefrLevel={cefrLevel}
                grammarPoint={content?.microGoal?.grammarPoint ?? ''}
                topic={content?.microGoal?.topic ?? ''}
                card={currentCard}
                cardKey={`${cardIndex}`}
                targetLanguage={stage.language}
                explanationLanguage={stage.explanationLanguage}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
