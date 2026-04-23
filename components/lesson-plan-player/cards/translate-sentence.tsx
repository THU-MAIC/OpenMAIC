'use client';

import { useState } from 'react';
import type { TranslateSentenceCard } from '@/lib/types/stage';

export function TranslateSentenceCard({ card }: { card: TranslateSentenceCard }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-sky-50 dark:bg-sky-900/20 rounded-xl p-5 text-center">
        <p className="text-xs text-sky-600 dark:text-sky-400 font-medium mb-1">{card.source.language}</p>
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{card.source.text}</p>
      </div>
      {card.mode === 'closed' && card.options ? (
        <div className="flex flex-col gap-2">
          {(card.options ?? []).map((opt, i) => (
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
      ) : (
        <>
          {!revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="self-start px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              Show translation
            </button>
          ) : (
            <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 border border-green-200/50 dark:border-green-700/30">
              <p className="text-xs text-green-600 dark:text-green-400 font-medium mb-1">Translation</p>
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{card.answer}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
