'use client';

import { CODING_LANGUAGES } from '@/lib/quiz/constants';
import type { CodingDifficulty, CodingLanguage } from '@/lib/quiz/types';

const difficulties: CodingDifficulty[] = ['easy', 'medium', 'hard'];

export function CodingQuizConfig({
  language,
  difficulty,
  onLanguageChange,
  onDifficultyChange,
}: {
  language: CodingLanguage;
  difficulty: CodingDifficulty;
  onLanguageChange: (value: CodingLanguage) => void;
  onDifficultyChange: (value: CodingDifficulty) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="space-y-2 text-sm">
        <span className="font-medium">Programming Language</span>
        <select
          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-950"
          value={language}
          onChange={(event) => onLanguageChange(event.target.value as CodingLanguage)}
        >
          {CODING_LANGUAGES.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <label className="space-y-2 text-sm">
        <span className="font-medium">Difficulty</span>
        <select
          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-950"
          value={difficulty}
          onChange={(event) => onDifficultyChange(event.target.value as CodingDifficulty)}
        >
          {difficulties.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
