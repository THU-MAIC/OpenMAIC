'use client';

import type { DialogSnippetCard } from '@/lib/types/stage';

export function DialogSnippetCard({ card }: { card: DialogSnippetCard }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-500 dark:text-gray-400 italic">{card.primer}</p>
      <div className="flex flex-col gap-2">
        {(card.turns ?? []).map((turn, i) => (
          <div
            key={i}
            className={`flex gap-3 ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                i % 2 === 0
                  ? 'bg-gray-100 dark:bg-gray-700 rounded-tl-sm'
                  : 'bg-blue-100 dark:bg-blue-900/30 rounded-tr-sm'
              }`}
            >
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{turn.lithuanian}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{turn.english}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
