'use client';

import { useState } from 'react';
import type { RoleplayCard } from '@/lib/types/stage';

export function RoleplayCard({ card }: { card: RoleplayCard }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-500 dark:text-gray-400 italic">{card.scenario}</p>
      <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-5">
        <p className="text-sm text-amber-700 dark:text-amber-400 font-medium mb-1">Your cue</p>
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{card.cue}</p>
      </div>
      {card.mode === 'closed' && card.options && (
        <div className="flex flex-col gap-2">
          {(card.options ?? []).map((opt, i) => (
            <button
              key={i}
              onClick={() => setRevealed(true)}
              className="text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 transition-colors"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {card.mode === 'free' && !revealed && (
        <button
          onClick={() => setRevealed(true)}
          className="self-start px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        >
          Show answer
        </button>
      )}
      {revealed && (
        <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 border border-green-200/50 dark:border-green-700/30">
          <p className="text-xs text-green-600 dark:text-green-400 font-medium mb-1">Answer</p>
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{card.answer}</p>
        </div>
      )}
    </div>
  );
}
