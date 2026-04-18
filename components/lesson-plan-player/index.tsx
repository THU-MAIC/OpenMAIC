'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Stage, Scene, LessonPlanContent } from '@/lib/types/stage';
import { CardDispatch } from './card-dispatch';

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

export function LessonPlanPlayer({ stage, scene }: LessonPlanPlayerProps) {
  const content = scene.content as LessonPlanContent;
  const cards = content.cards;

  const [cardIndex, setCardIndex] = useState(0);
  const currentCard = cards[cardIndex];
  const cefrColor = CEFR_COLORS[content.microGoal.cefrLevel] ?? 'bg-gray-100 text-gray-600';

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 bg-white dark:bg-gray-800 border-b border-gray-200/60 dark:border-gray-700/60">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
            {stage.name}
          </h1>
          <span className={`shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${cefrColor}`}>
            {content.microGoal.cefrLevel}
          </span>
        </div>
      </div>

      {/* Micro-goal banner */}
      <div className="shrink-0 px-6 py-3 bg-white dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700/40">
        <div className="max-w-2xl mx-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span><span className="font-medium text-gray-700 dark:text-gray-300">Topic:</span> {content.microGoal.topic}</span>
          <span><span className="font-medium text-gray-700 dark:text-gray-300">Grammar:</span> {content.microGoal.grammarPoint}</span>
        </div>
      </div>

      {/* Card area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          {/* Card counter */}
          <p className="text-xs text-gray-400 dark:text-gray-500 font-medium mb-4 text-center tracking-wide uppercase">
            Card {cardIndex + 1} of {cards.length}
          </p>

          {/* Card content */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200/60 dark:border-gray-700/60 p-6">
            {currentCard && <CardDispatch key={`${cardIndex}-${currentCard.kind}`} card={currentCard} />}
          </div>
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
  );
}
