'use client';

import { useState } from 'react';
import type { CaseTransformCard } from '@/lib/types/stage';

export function CaseTransformCard({ card }: { card: CaseTransformCard }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-5">
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Source</p>
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{card.source.lithuanian}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">{card.source.english}</p>
      </div>
      <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4">
        <p className="text-sm text-amber-700 dark:text-amber-400">{card.instruction}</p>
        {card.hint && <p className="mt-1 text-xs text-amber-600 dark:text-amber-500 italic">Hint: {card.hint}</p>}
      </div>
      {!revealed ? (
        <button
          onClick={() => setRevealed(true)}
          className="self-start px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        >
          Show answer
        </button>
      ) : (
        <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 border border-green-200/50 dark:border-green-700/30">
          <p className="text-xs text-green-600 dark:text-green-400 font-medium mb-1">Answer</p>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{card.expected}</p>
        </div>
      )}
    </div>
  );
}
