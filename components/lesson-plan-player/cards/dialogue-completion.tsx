'use client';

import { useState } from 'react';
import type { DialogueCompletionCard } from '@/lib/types/stage';

export function DialogueCompletionCard({ card }: { card: DialogueCompletionCard }) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-500 dark:text-gray-400 italic">{card.primer}</p>
      <div className="flex flex-col gap-2">
        {(card.turns ?? []).map((turn, i) => {
          const isGap = turn.isGap;
          return (
            <div key={i} className={`flex gap-3 ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                  i % 2 === 0
                    ? 'bg-gray-100 dark:bg-gray-700 rounded-tl-sm'
                    : 'bg-blue-100 dark:bg-blue-900/30 rounded-tr-sm'
                } ${isGap ? 'border-2 border-dashed border-blue-400 dark:border-blue-500' : ''}`}
              >
                {isGap ? (
                  <p className="text-sm text-blue-500 dark:text-blue-400">
                    {selected ?? '???'}
                  </p>
                ) : (
                  <>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{turn?.lithuanian}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{turn?.english}</p>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        {(card.options ?? []).map((opt, i) => (
          <button
            key={i}
            onClick={() => setSelected(opt)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
              selected === opt
                ? opt === card.answer
                  ? 'bg-green-100 dark:bg-green-900/30 border-green-400 text-green-800 dark:text-green-300'
                  : 'bg-red-100 dark:bg-red-900/30 border-red-400 text-red-800 dark:text-red-300'
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
