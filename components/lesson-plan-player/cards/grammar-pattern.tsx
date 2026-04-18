'use client';

import type { GrammarPatternCard } from '@/lib/types/stage';

export function GrammarPatternCard({ card }: { card: GrammarPatternCard }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-4">
        <p className="text-sm font-medium text-indigo-700 dark:text-indigo-300">{card.observation}</p>
      </div>
      <div className="flex flex-col gap-2">
        {card.examples.map((ex, i) => (
          <div key={i} className="flex items-baseline gap-3 px-4 py-3 rounded-lg bg-gray-50 dark:bg-gray-800">
            <span className="text-base font-semibold text-gray-900 dark:text-gray-100">{ex.lithuanian}</span>
            <span className="text-sm text-gray-500 dark:text-gray-400">— {ex.english}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
