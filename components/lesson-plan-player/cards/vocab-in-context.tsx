'use client';

import type { VocabInContextCard } from '@/lib/types/stage';

export function VocabInContextCard({ card }: { card: VocabInContextCard }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-teal-50 dark:bg-teal-900/20 rounded-xl p-6 text-center">
        <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{card.word.lithuanian}</p>
        {card.word.pronunciation && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">[{card.word.pronunciation}]</p>
        )}
        <p className="mt-2 text-base text-gray-600 dark:text-gray-300">{card.word.english}</p>
      </div>
      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4">
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">In context</p>
        <p className="text-base font-medium text-gray-900 dark:text-gray-100">{card.carrier.lithuanian}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{card.carrier.english}</p>
      </div>
    </div>
  );
}
