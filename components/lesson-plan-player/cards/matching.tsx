'use client';

import { useState, useCallback } from 'react';
import type { MatchingCard } from '@/lib/types/stage';

export function MatchingCard({ card }: { card: MatchingCard }) {
  const lefts = (card.pairs ?? []).map((p) => p.left);
  const rights = [...(card.pairs ?? []).map((p) => p.right)].sort(() => Math.random() - 0.5);

  const [selectedLeft, setSelectedLeft] = useState<number | null>(null);
  const [matched, setMatched] = useState<Record<number, number>>({});

  const handleLeft = useCallback((i: number) => {
    if (matched[i] !== undefined) return;
    setSelectedLeft(i);
  }, [matched]);

  const handleRight = useCallback((rightVal: string) => {
    if (selectedLeft === null) return;
    const correctRight = card.pairs[selectedLeft].right;
    if (rightVal === correctRight) {
      setMatched((m) => ({ ...m, [selectedLeft]: rights.indexOf(rightVal) }));
    }
    setSelectedLeft(null);
  }, [selectedLeft, card.pairs, rights]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">Match each word to its meaning</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-2">
          {lefts.map((left, i) => (
            <button
              key={i}
              onClick={() => handleLeft(i)}
              className={`px-3 py-2.5 rounded-lg text-sm text-left transition-colors border ${
                matched[i] !== undefined
                  ? 'bg-green-100 dark:bg-green-900/30 border-green-400 text-green-800 dark:text-green-300'
                  : selectedLeft === i
                    ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-400 text-blue-800 dark:text-blue-300'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {left}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {rights.map((right, i) => {
            const isMatched = Object.values(matched).includes(i);
            return (
              <button
                key={i}
                onClick={() => handleRight(right)}
                disabled={isMatched || selectedLeft === null}
                className={`px-3 py-2.5 rounded-lg text-sm text-left transition-colors border ${
                  isMatched
                    ? 'bg-green-100 dark:bg-green-900/30 border-green-400 text-green-800 dark:text-green-300'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40'
                }`}
              >
                {right}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
