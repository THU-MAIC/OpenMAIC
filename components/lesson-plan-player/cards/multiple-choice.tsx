'use client';

import { useState } from 'react';
import type { MultipleChoiceCard } from '@/lib/types/stage';

export function MultipleChoiceCard({ card }: { card: MultipleChoiceCard }) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-5">
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{card.prompt}</p>
        {card.english && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{card.english}</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {card.options.map((opt, i) => (
          <button
            key={i}
            onClick={() => !selected && setSelected(opt)}
            className={`px-4 py-3 rounded-lg text-sm text-left font-medium transition-colors border ${
              selected === opt
                ? opt === card.answer
                  ? 'bg-green-100 dark:bg-green-900/30 border-green-400 text-green-800 dark:text-green-300'
                  : 'bg-red-100 dark:bg-red-900/30 border-red-400 text-red-800 dark:text-red-300'
                : selected && opt === card.answer
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-300 text-green-700 dark:text-green-400'
                  : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
