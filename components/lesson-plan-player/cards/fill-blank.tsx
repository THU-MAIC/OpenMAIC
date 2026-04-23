'use client';

import { useState } from 'react';
import type { FillBlankCard } from '@/lib/types/stage';

export function FillBlankCard({ card }: { card: FillBlankCard }) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-5 text-center">
        <p className="text-lg text-gray-900 dark:text-gray-100">
          {card.sentence.before}
          <span
            className={`inline-block mx-1 px-3 py-0.5 rounded border-b-2 min-w-[80px] text-center font-semibold ${
              selected
                ? selected === card.answer
                  ? 'border-green-400 text-green-700 dark:text-green-400'
                  : 'border-red-400 text-red-700 dark:text-red-400'
                : 'border-blue-400 text-blue-500'
            }`}
          >
            {selected ?? '___'}
          </span>
          {card.sentence.after}
        </p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{card.sentence.english}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {(card.options ?? []).map((opt, i) => (
          <button
            key={i}
            onClick={() => setSelected(opt)}
            disabled={!!selected}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
              selected === opt
                ? opt === card.answer
                  ? 'bg-green-100 dark:bg-green-900/30 border-green-400 text-green-800 dark:text-green-300'
                  : 'bg-red-100 dark:bg-red-900/30 border-red-400 text-red-800 dark:text-red-300'
                : selected && opt === card.answer
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-300 text-green-700 dark:text-green-400'
                  : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
