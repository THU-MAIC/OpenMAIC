'use client';

import type { MistakeSpotlightCard } from '@/lib/types/stage';

export function MistakeSpotlightCard({ card }: { card: MistakeSpotlightCard }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 border border-red-200/50 dark:border-red-700/30">
        <p className="text-xs text-red-500 dark:text-red-400 font-medium mb-1">Wrong</p>
        <p className="text-base font-semibold text-red-700 dark:text-red-300 line-through">{card.wrong}</p>
      </div>
      <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 border border-green-200/50 dark:border-green-700/30">
        <p className="text-xs text-green-600 dark:text-green-400 font-medium mb-1">Correct</p>
        <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{card.correct}</p>
      </div>
      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4">
        <p className="text-sm text-gray-700 dark:text-gray-300">{card.explanation}</p>
      </div>
      {card.carrier && (
        <div className="px-4 py-3 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{card.carrier.lithuanian}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{card.carrier.english}</p>
        </div>
      )}
    </div>
  );
}
