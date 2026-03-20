'use client';

import type { PlacementDifficulty } from '@/lib/quiz/types';

interface PlacementQuizConfigProps {
  company: string;
  difficulty: PlacementDifficulty;
  onCompanyChange: (value: string) => void;
  onDifficultyChange: (value: PlacementDifficulty) => void;
}

const companies = ['General', 'TCS', 'Infosys', 'Wipro', 'Cognizant', 'Accenture'];
const difficulties: PlacementDifficulty[] = ['easy', 'medium', 'hard'];

export function PlacementQuizConfig(props: PlacementQuizConfigProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="space-y-2 text-sm">
        <span className="font-medium">Company Style</span>
        <select
          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-950"
          value={props.company}
          onChange={(event) => props.onCompanyChange(event.target.value)}
        >
          {companies.map((company) => (
            <option key={company} value={company}>{company}</option>
          ))}
        </select>
      </label>
      <label className="space-y-2 text-sm">
        <span className="font-medium">Difficulty</span>
        <select
          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-950"
          value={props.difficulty}
          onChange={(event) => props.onDifficultyChange(event.target.value as PlacementDifficulty)}
        >
          {difficulties.map((difficulty) => (
            <option key={difficulty} value={difficulty}>{difficulty}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
