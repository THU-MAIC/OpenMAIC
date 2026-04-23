'use client';

import type { ShadowCard } from '@/lib/types/stage';

export function ShadowCard({ card }: { card: ShadowCard }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-500 dark:text-gray-400 italic">{card.instruction}</p>
      <div className="bg-purple-50 dark:bg-purple-900/20 rounded-xl p-6 text-center">
        <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{card.target?.lithuanian}</p>
        {card.target?.pronunciation && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">[{card.target.pronunciation}]</p>
        )}
        <p className="mt-3 text-base text-gray-600 dark:text-gray-300">{card.target?.english}</p>
      </div>
    </div>
  );
}
