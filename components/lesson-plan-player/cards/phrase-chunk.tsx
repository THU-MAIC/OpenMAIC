'use client';

import type { PhraseChunkCard } from '@/lib/types/stage';

export function PhraseChunkCard({ card }: { card: PhraseChunkCard }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-500 dark:text-gray-400 italic">{card.situation}</p>
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-6 text-center">
        <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{card.phrase.lithuanian}</p>
        {card.phrase.pronunciation && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">[{card.phrase.pronunciation}]</p>
        )}
        <p className="mt-3 text-base text-gray-600 dark:text-gray-300">{card.phrase.english}</p>
      </div>
    </div>
  );
}
